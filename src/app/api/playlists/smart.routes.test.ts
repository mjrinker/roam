/** Making and changing smart playlists through the API, and that their items can't be edited by hand. */
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

import { mediaFiles, ratings } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { POST as createRoute } from "../servers/[serverId]/playlists/route";
import { GET as getOne, PATCH as patchOne } from "../playlists/[id]/route";
import { POST as refreshRoute } from "../playlists/[id]/refresh/route";
import { POST as addItemRoute } from "../playlists/[id]/items/route";
import { GET as v1Playlist } from "../v1/servers/[serverId]/playlists/[playlistId]/route";

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
const send = (method: string, body?: unknown) => new Request("https://roam.example/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `spadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `spme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = async (name: string, genres: string[]) => {
    const t = await makeTitle(db, lib.id, { kind: "movie", name, genres });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `sp${++n}`, filename: "m.mp4" });
    return t;
  };
  return { server, me, lib, film, sid: { serverId: server.id } };
}

describe("smart playlists through the API", () => {
  it("are created with rules, fill themselves, show their rules, and refuse hand edits", async () => {
    const w = await world();
    const a = await w.film("Funny", ["Comedy"]);
    await w.film("Sad", ["Drama"]);
    await as(w.me);
    const made = await createRoute(send("POST", { name: "Comedies", smartRules: { media: "movies", genres: ["Comedy"] } }), ctx(w.sid));
    expect(made.status).toBe(201);
    const id = (await json(made)).id as string;
    const list = await json(await v1Playlist(send("GET"), ctx({ ...w.sid, playlistId: id })));
    expect(list.items.map((i: { name: string }) => i.name)).toEqual(["Funny"]);
    const detail = await json(await getOne(send("GET"), ctx({ id })));
    expect(detail).toMatchObject({ smart: true, smartRules: { media: "movies", genres: ["Comedy"], sort: "title", limit: 50 } });
    expect(detail.can.editItems).toBe(false);
    expect((await addItemRoute(send("POST", { titleId: a.id }), ctx({ id }))).status).toBe(403);
  });

  it("change when their rules are changed, and can be refreshed on request", async () => {
    const w = await world();
    const film = await w.film("Sad", ["Drama"]);
    await as(w.me);
    const id = (await json(await createRoute(send("POST", { name: "Rated", smartRules: { media: "movies", minStars: 8 } }), ctx(w.sid)))).id as string;
    const items = async () => (await json(await v1Playlist(send("GET"), ctx({ ...w.sid, playlistId: id })))).items.map((i: { name: string }) => i.name);
    expect(await items()).toEqual([]);
    await db.insert(ratings).values({ viewerId: w.me.viewer.id, ownerKind: "title", ownerId: film.id, halfStars: 9 });
    expect(await items()).toEqual([]); // not refreshed yet
    expect((await refreshRoute(send("POST"), ctx({ id }))).status).toBe(200);
    expect(await items()).toEqual(["Sad"]);
    expect((await patchOne(send("PATCH", { smartRules: { media: "movies", minStars: 10 } }), ctx({ id }))).status).toBe(200);
    expect(await items()).toEqual([]);
  });

  it("refuse bad rules, rules on an ordinary playlist, refreshing an ordinary one, and anyone else's playlist", async () => {
    const w = await world();
    await as(w.me);
    expect((await createRoute(send("POST", { name: "Bad", smartRules: { media: "music" } }), ctx(w.sid))).status).toBe(400);
    expect((await createRoute(send("POST", { name: "Bad", smartRules: { media: "movies", limit: 9999 } }), ctx(w.sid))).status).toBe(400);
    const plain = (await json(await createRoute(send("POST", { name: "Plain" }), ctx(w.sid)))).id as string;
    expect((await patchOne(send("PATCH", { smartRules: { media: "movies" } }), ctx({ id: plain }))).status).toBe(409);
    expect((await refreshRoute(send("POST"), ctx({ id: plain }))).status).toBe(400);
    const smart = (await json(await createRoute(send("POST", { name: "Mine", smartRules: { media: "movies" } }), ctx(w.sid)))).id as string;
    const stranger = await makeAccount(db, `spstranger${++n}`);
    await joinServer(db, w.server.id, stranger.accountId);
    await as(stranger);
    expect((await refreshRoute(send("POST"), ctx({ id: smart }))).status).toBe(404); // private to its owner
    expect((await patchOne(send("PATCH", { smartRules: { media: "movies" } }), ctx({ id: smart }))).status).toBe(404);
  });
});
