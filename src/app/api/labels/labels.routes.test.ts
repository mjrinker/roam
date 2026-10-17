/** A profile's own labels: making, renaming, deleting and putting titles under them, and that they stay private to the profile. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { eq } from "drizzle-orm";
import { labelItems, labels } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { MAX_LABELS } from "@/lib/labels/names";
import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";
import { PUT } from "./[id]/items/route";
import { GET as v1Title } from "../v1/servers/[serverId]/titles/[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const send = (method: string, body?: unknown, url = "https://roam.example/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const make = async (name: string, titleId?: string) => json(await POST(send("POST", { name, titleId })));
const list = async () => (await json(await GET(send("GET")))).labels as { id: string; name: string; count: number; has?: boolean }[];
const put = (labelId: string, titleId: string, on: boolean) => PUT(send("PUT", { titleId, on }), ctx({ id: labelId }));

let n = 0;
async function world() {
  const admin = await makeAccount(db, `ladmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `lme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const other = await makeAccount(db, `lother${++n}`);
  await joinServer(db, server.id, other.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  const film2 = await makeTitle(db, movies.id, { kind: "movie", name: "Film Two" });
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const { show } = await makeShow(db, shows.id, 1, { name: "Show" });
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const photo = await makeTitle(db, photos.id, { kind: "photo", name: "Snap" });
  return { server, me, other, film, film2, show, photo, sid: { serverId: server.id } };
}

describe("making, renaming and deleting labels", () => {
  it("makes labels, lists them A to Z with counts, renames one and deletes one", async () => {
    const w = await world();
    await as(w.me);
    const a = await make("  Date   night ");
    expect(a).toMatchObject({ name: "Date night", count: 0 });
    await make("Christmas", w.film.id);
    expect((await list()).map((l) => [l.name, l.count])).toEqual([["Christmas", 1], ["Date night", 0]]);
    expect((await json(await PATCH(send("PATCH", { name: "Anniversary" }), ctx({ id: a.id }))))).toMatchObject({ name: "Anniversary" });
    expect((await list()).map((l) => l.name)).toEqual(["Anniversary", "Christmas"]);
    expect((await DELETE(send("DELETE"), ctx({ id: a.id }))).status).toBe(200);
    expect((await list()).map((l) => l.name)).toEqual(["Christmas"]);
    expect((await DELETE(send("DELETE"), ctx({ id: a.id }))).status).toBe(404);
  });

  it("refuses a blank, an over-long or repeated name (however it is spelled) and too many labels", async () => {
    const w = await world();
    await as(w.me);
    await make("Favourites");
    expect((await POST(send("POST", { name: "   " }))).status).toBe(400);
    expect((await POST(send("POST", { name: "x".repeat(41) }))).status).toBe(400);
    expect((await POST(send("POST", { name: "FAVOURITES" }))).status).toBe(409);
    expect((await POST(send("POST", { name: "favourités" }))).status).toBe(409); // case and accents are not told apart
    const b = await make("Second");
    expect((await PATCH(send("PATCH", { name: " favourites " }), ctx({ id: b.id }))).status).toBe(409);
    expect((await PATCH(send("PATCH", { name: "Second" }), ctx({ id: b.id }))).status).toBe(200); // its own name again is fine
    expect((await POST(send("POST", { name: "ok", extra: 1 }))).status).toBe(400);
    for (let i = 0; i < MAX_LABELS - 2; i++) await make(`Label ${i}`);
    expect((await list()).length).toBe(MAX_LABELS);
    expect((await POST(send("POST", { name: "One too many" }))).status).toBe(400);
  });
});

describe("labelling titles", () => {
  it("puts movies, shows and nothing else under a label, and takes them off", async () => {
    const w = await world();
    await as(w.me);
    const l = await make("Weekend");
    expect((await put(l.id, w.film.id, true)).status).toBe(200);
    expect((await put(l.id, w.film.id, true)).status).toBe(200); // again is fine
    await put(l.id, w.show.id, true);
    expect((await list())[0].count).toBe(2);
    expect((await put(l.id, w.photo.id, true)).status).toBe(404);
    expect((await put(l.id, "123e4567-e89b-42d3-a456-426614174000", true)).status).toBe(404);
    expect((await PUT(send("PUT", { titleId: w.film.id }), ctx({ id: l.id }))).status).toBe(400);
    await put(l.id, w.film.id, false);
    expect((await list())[0].count).toBe(1);
  });

  it("tells a title's page which labels it has, and shows them on the title in the API", async () => {
    const w = await world();
    await as(w.me);
    const a = await make("Alpha", w.film.id);
    await make("Beta");
    const forTitle = (await json(await GET(send("GET", undefined, `https://roam.example/api/labels?title=${w.film.id}`)))).labels as { name: string; has: boolean }[];
    expect(forTitle.map((x) => [x.name, x.has])).toEqual([["Alpha", true], ["Beta", false]]);
    expect((await GET(send("GET", undefined, `https://roam.example/api/labels?title=${w.photo.id}`))).status).toBe(404);
    const body = await json(await v1Title(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(body.labels).toEqual([{ id: a.id, name: "Alpha" }]);
    const other = await json(await v1Title(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film2.id })));
    expect(other.labels).toEqual([]);
  });

  it("keeps each profile's labels to itself", async () => {
    const w = await world();
    await as(w.me);
    const mine = await make("Mine", w.film.id);
    await as(w.other);
    expect(await list()).toEqual([]);
    expect((await put(mine.id, w.film2.id, true)).status).toBe(404);
    expect((await PATCH(send("PATCH", { name: "Stolen" }), ctx({ id: mine.id }))).status).toBe(404);
    expect((await DELETE(send("DELETE"), ctx({ id: mine.id }))).status).toBe(404);
    expect((await make("Mine", w.film.id)).name).toBe("Mine"); // the same name is fine for someone else
    const body = await json(await v1Title(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(body.labels.map((x: { name: string }) => x.name)).toEqual(["Mine"]);
    expect(await db.select().from(labelItems).where(eq(labelItems.titleId, w.film.id))).toHaveLength(2); // one under each profile's own label
    expect(await db.select().from(labels).where(eq(labels.viewerId, w.me.viewer.id))).toHaveLength(1);
  });

  it("refuses everything when signed out, and a title on a server the profile is not in", async () => {
    const w = await world();
    h.headers = {};
    expect((await GET(send("GET"))).status).toBe(401);
    expect((await POST(send("POST", { name: "x" }))).status).toBe(401);
    const stranger = await makeAccount(db, `lstranger${++n}`);
    await as(stranger);
    const l = await make("Mine");
    expect((await put(l.id, w.film.id, true)).status).toBe(404);
    expect((await POST(send("POST", { name: "Another", titleId: w.film.id }))).status).toBe(404);
  });
});
