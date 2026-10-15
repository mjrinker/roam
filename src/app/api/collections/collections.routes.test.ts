/** Making and filling collections (admin only) and reading them through the API. */
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
import { collections, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { syncSeriesCollections } from "@/lib/collections/sync";
import { GET as list, POST as create } from "./route";
import { PATCH as rename, DELETE as remove } from "./[id]/route";
import { PUT as addItems, DELETE as removeItem } from "./[id]/items/route";
import { GET as v1List } from "../v1/servers/[serverId]/libraries/[libraryId]/collections/route";
import { GET as v1One } from "../v1/servers/[serverId]/collections/[id]/route";
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
const send = (url: string, method: string, body?: unknown) => new Request(`https://roam.example${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `cadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `cmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const [a, b] = [await makeTitle(db, lib.id, { kind: "movie", name: "Alien", year: 1979, collectionTmdbId: 7, collectionName: "Alien Collection" }), await makeTitle(db, lib.id, { kind: "movie", name: "Aliens", year: 1986, collectionTmdbId: 7, collectionName: "Alien Collection" })];
  const lone = await makeTitle(db, lib.id, { kind: "movie", name: "Lone" });
  await syncSeriesCollections(db, lib.id);
  return { admin, member, server, lib, a, b, lone, sid: { serverId: server.id } };
}

describe("making collections", () => {
  it("lets the server's admin create, fill, rename, empty and delete one", async () => {
    const w = await world();
    await as(w.admin);
    const made = await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "  Friday  night " }));
    expect(made.status).toBe(200);
    const id = (await json(made)).id as string;
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "friday night" }))).status).toBe(409);
    expect((await addItems(send(`/api/collections/${id}/items`, "PUT", { titleIds: [w.lone.id, w.a.id] }), ctx({ id }))).status).toBe(200);
    const listed = await json(await list(send(`/api/collections?libraryId=${w.lib.id}&titleId=${w.lone.id}`, "GET")));
    expect(listed.collections).toEqual([{ id, name: "Friday night", has: true }]);
    expect((await rename(send(`/api/collections/${id}`, "PATCH", { name: "Saturday" }), ctx({ id }))).status).toBe(200);
    expect((await removeItem(send(`/api/collections/${id}/items`, "DELETE", { titleId: w.a.id }), ctx({ id }))).status).toBe(200);
    await as(w.member);
    const seen = await json(await v1One(send("/x", "GET"), ctx({ ...w.sid, id })));
    expect(seen.collection.name).toBe("Saturday");
    expect(seen.items.map((i: { name: string }) => i.name)).toEqual(["Lone"]);
    await as(w.admin);
    expect((await remove(send(`/api/collections/${id}`, "DELETE"), ctx({ id }))).status).toBe(200);
    expect(await db.select().from(collections).where(eq(collections.id, id))).toEqual([]);
  });

  it("refuses everyone else: members, signed-out callers, other servers, bad input, and a film series", async () => {
    const w = await world();
    const other = await world();
    await as(w.member);
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "Nope" }))).status).toBe(404);
    expect((await list(send(`/api/collections?libraryId=${w.lib.id}`, "GET"))).status).toBe(404);
    await as(other.admin);
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "Nope" }))).status).toBe(404); // an admin of a different server
    h.headers = {};
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "Nope" }))).status).toBe(404);
    await as(w.admin);
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "   " }))).status).toBe(400);
    expect((await create(send("/api/collections", "POST", { libraryId: w.lib.id, name: "x".repeat(81) }))).status).toBe(400);
    expect((await create(send("/api/collections", "POST", { libraryId: "nope", name: "x" }))).status).toBe(400);
    expect((await create(new Request("https://roam.example/api/collections", { method: "POST", body: "name=x" }))).status).toBe(415);
    const [series] = await db.select().from(collections).where(eq(collections.libraryId, w.lib.id));
    expect((await rename(send(`/api/collections/${series.id}`, "PATCH", { name: "Mine" }), ctx({ id: series.id }))).status).toBe(404);
    expect((await remove(send(`/api/collections/${series.id}`, "DELETE"), ctx({ id: series.id }))).status).toBe(404);
    expect((await addItems(send(`/api/collections/${series.id}/items`, "PUT", { titleIds: [w.lone.id] }), ctx({ id: series.id }))).status).toBe(404);
  });
});

describe("reading collections through the API", () => {
  it("lists a library's collections and opens one, and tells a title which it is in", async () => {
    const w = await world();
    await as(w.member);
    const cards = await json(await v1List(send("/x", "GET"), ctx({ ...w.sid, libraryId: w.lib.id })));
    expect(cards.collections).toEqual([expect.objectContaining({ name: "Alien Collection", kind: "tmdb", count: 2 })]);
    const one = await json(await v1One(send("/x", "GET"), ctx({ ...w.sid, id: cards.collections[0].id })));
    expect(one.items.map((i: { name: string; subtitle: string }) => [i.name, i.subtitle])).toEqual([["Alien", "1979"], ["Aliens", "1986"]]);
    const title = await json(await v1Title(send("/x", "GET"), ctx({ ...w.sid, id: w.a.id })));
    expect(title.collections).toEqual([{ id: cards.collections[0].id, name: "Alien Collection" }]);
    expect(title.moreInCollections).toEqual([{ id: cards.collections[0].id, name: "Alien Collection", items: [expect.objectContaining({ type: "movie", id: w.b.id, name: "Aliens", subtitle: "1986" })] }]); // the rest, not this one
  });

  it("hides them from a profile whose age limit leaves under two films, and from other servers", async () => {
    const w = await world();
    const other = await world();
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.member.viewer.id));
    await as(w.member);
    expect((await json(await v1List(send("/x", "GET"), ctx({ ...w.sid, libraryId: w.lib.id })))).collections).toEqual([]);
    const [c] = await db.select().from(collections).where(eq(collections.libraryId, other.lib.id));
    await as(other.member);
    expect((await v1One(send("/x", "GET"), ctx({ ...other.sid, id: c.id }))).status).toBe(200);
    await as(w.member);
    expect((await v1One(send("/x", "GET"), ctx({ ...w.sid, id: c.id }))).status).toBe(404);
    h.headers = {};
    expect((await v1List(send("/x", "GET"), ctx({ ...w.sid, libraryId: w.lib.id }))).status).toBe(401);
  });
});
