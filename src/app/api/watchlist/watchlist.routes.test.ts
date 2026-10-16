/** The watch list: putting things on and off, who sees what, the v1 API, and things leaving the list once finished. */
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
import { watchState, watchlistItems } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { onWatchlist, listWatchlist, dropFinished } from "@/lib/watchlist/queries";
import { libraryActor } from "@/lib/content/library-access";
import { setDone } from "@/lib/watch/mark";
import { PUT } from "./route";
import { PATCH as watchPatch } from "../watch-state/route";
import { GET as v1List } from "../v1/servers/[serverId]/watchlist/route";
import { GET as v1Title } from "../v1/servers/[serverId]/titles/[id]/route";
import { GET as v1Home } from "../v1/servers/[serverId]/home/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const put = (body: unknown) => PUT(new Request("https://roam.example/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const has = async (who: Awaited<ReturnType<typeof makeAccount>>, id: string) => (await onWatchlist(db, who.viewer.id, [id])).has(id);
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const wsPatch = (body: unknown) => watchPatch(new Request("https://roam.example/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

let n = 0;
async function world() {
  const admin = await makeAccount(db, `wadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `wmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film", year: 2001 });
  const other = await makeTitle(db, movies.id, { kind: "movie", name: "Other film" });
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const { show, episodes } = await makeShow(db, shows.id, 2, { name: "Show" });
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const photo = await makeTitle(db, photos.id, { kind: "photo", name: "Snap" });
  return { admin, server, member, film, other, show, episodes, photo, sid: { serverId: server.id } };
}

describe("PUT /api/watchlist", () => {
  it("puts a movie and a show on the list, is happy to be asked twice, and takes them off", async () => {
    const w = await world();
    await as(w.member);
    expect((await put({ titleId: w.film.id, on: true })).status).toBe(200);
    expect((await put({ titleId: w.film.id, on: true })).status).toBe(200);
    await put({ titleId: w.show.id, on: true });
    expect([await has(w.member, w.film.id), await has(w.member, w.show.id)]).toEqual([true, true]);
    expect(await db.select().from(watchlistItems).where(eq(watchlistItems.viewerId, w.member.viewer.id))).toHaveLength(2);
    expect((await put({ titleId: w.film.id, on: false })).status).toBe(200);
    expect([await has(w.member, w.film.id), await has(w.member, w.show.id)]).toEqual([false, true]);
  });

  it("keeps each profile's list to itself", async () => {
    const w = await world();
    await as(w.member);
    await put({ titleId: w.film.id, on: true });
    expect(await has(w.admin, w.film.id)).toBe(false);
    await as(w.admin);
    expect((await json(await v1List(new Request("https://roam.example/x"), { params: Promise.resolve(w.sid) } as never))).items).toEqual([]);
  });

  it("refuses photos, things on a server you are not in, unknown ids and nonsense", async () => {
    const w = await world();
    await as(w.member);
    expect((await put({ titleId: w.photo.id, on: true })).status).toBe(404);
    expect((await put({ titleId: "123e4567-e89b-42d3-a456-426614174000", on: true })).status).toBe(404);
    expect((await put({ titleId: "nope", on: true })).status).toBe(400);
    expect((await put({ titleId: w.film.id })).status).toBe(400);
    expect((await put({ titleId: w.film.id, on: true, extra: 1 })).status).toBe(400);
    const stranger = await makeAccount(db, `wstranger${++n}`);
    await as(stranger);
    expect((await put({ titleId: w.film.id, on: true })).status).toBeGreaterThanOrEqual(403);
    expect(await has(stranger, w.film.id)).toBe(false);
  });
});

describe("what the list shows", () => {
  it("lists the newest first, only what the profile may still see", async () => {
    const w = await world();
    const { titles } = await import("@/lib/db/schema");
    await db.insert(watchlistItems).values([
      { viewerId: w.member.viewer.id, titleId: w.film.id, addedAt: new Date("2026-01-01T00:00:00Z") },
      { viewerId: w.member.viewer.id, titleId: w.show.id, addedAt: new Date("2026-02-01T00:00:00Z") },
      { viewerId: w.member.viewer.id, titleId: w.other.id, addedAt: new Date("2026-03-01T00:00:00Z") },
    ]);
    const actor = libraryActor({ profile: { id: w.member.accountId }, role: "viewer" } as never, w.server.id);
    const viewer = { maxAge: null, allowUnrated: true, locale: "en-US" } as never;
    const names = async (v = viewer) => (await listWatchlist(db, { actor, viewer: v, viewerId: w.member.viewer.id, serverId: w.server.id })).map((e) => e.name);
    expect(await names()).toEqual(["Other film", "Show", "Film"]);
    // a title too mature for the profile's limit is left out (not removed from the list)
    await db.update(titles).set({ ratingAges: { US: 17 } }).where(eq(titles.id, w.other.id));
    expect(await names({ maxAge: 13, allowUnrated: true, locale: "en-US" } as never)).toEqual(["Show", "Film"]);
    expect(await has(w.member, w.other.id)).toBe(true);
    // titles on another server are not listed here
    const elsewhere = await makeServer(db, w.admin.accountId);
    const otherLib = await makeLibrary(db, elsewhere.id, "movies", "everyone");
    const faraway = await makeTitle(db, otherLib.id, { kind: "movie", name: "Faraway" });
    await db.insert(watchlistItems).values({ viewerId: w.member.viewer.id, titleId: faraway.id });
    expect(await names()).toEqual(["Other film", "Show", "Film"]);
  });

  it("appears in the v1 API: the list, the home screen, and a flag on the title", async () => {
    const w = await world();
    await as(w.member);
    await put({ titleId: w.film.id, on: true });
    const list = await json(await v1List(new Request("https://roam.example/x"), { params: Promise.resolve(w.sid) } as never));
    expect(list.items).toMatchObject([{ type: "movie", id: w.film.id, name: "Film", subtitle: "2001", square: false }]);
    const home = await json(await v1Home(new Request("https://roam.example/x"), { params: Promise.resolve(w.sid) } as never));
    expect(home.watchlist).toMatchObject([{ id: w.film.id }]);
    const ask = async (id: string) => (await json(await v1Title(new Request("https://roam.example/x"), { params: Promise.resolve({ ...w.sid, id }) } as never))).inWatchlist;
    expect([await ask(w.film.id), await ask(w.other.id), await ask(w.show.id)]).toEqual([true, false, false]);
  });
});

describe("finishing takes things off the list", () => {
  it("drops a movie when the player reports it finished, but not when it is only partly watched", async () => {
    const w = await world();
    await as(w.member);
    await put({ titleId: w.film.id, on: true });
    await put({ titleId: w.other.id, on: true });
    await wsPatch({ ownerKind: "title", ownerId: w.film.id, positionSeconds: 60, durationSeconds: 6000, finished: false });
    expect(await has(w.member, w.film.id)).toBe(true);
    await wsPatch({ ownerKind: "title", ownerId: w.film.id, positionSeconds: 5990, durationSeconds: 6000, finished: true });
    expect([await has(w.member, w.film.id), await has(w.member, w.other.id)]).toEqual([false, true]);
  });

  it("drops a show only when its last episode is finished", async () => {
    const w = await world();
    await as(w.member);
    await put({ titleId: w.show.id, on: true });
    const eps = w.episodes;
    for (const e of eps.slice(0, -1)) await wsPatch({ ownerKind: "episode", ownerId: e.id, positionSeconds: 100, durationSeconds: 100, finished: true });
    expect(await has(w.member, w.show.id)).toBe(true);
    await wsPatch({ ownerKind: "episode", ownerId: eps[eps.length - 1].id, positionSeconds: 100, durationSeconds: 100, finished: true });
    expect(await has(w.member, w.show.id)).toBe(false);
  });

  it("drops what is marked as watched, and keeps it when marked as not watched again", async () => {
    const w = await world();
    await db.insert(watchlistItems).values([{ viewerId: w.member.viewer.id, titleId: w.film.id }, { viewerId: w.member.viewer.id, titleId: w.show.id }]);
    await setDone(db, { viewerId: w.member.viewer.id, owners: w.episodes.map((e) => ({ ownerKind: "episode" as const, ownerId: e.id, durationSeconds: 100 })), done: true });
    expect([await has(w.member, w.film.id), await has(w.member, w.show.id)]).toEqual([true, false]);
    await db.insert(watchlistItems).values({ viewerId: w.member.viewer.id, titleId: w.show.id });
    await setDone(db, { viewerId: w.member.viewer.id, owners: w.episodes.map((e) => ({ ownerKind: "episode" as const, ownerId: e.id, durationSeconds: 100 })), done: false });
    expect(await has(w.member, w.show.id)).toBe(true);
    await setDone(db, { viewerId: w.member.viewer.id, owners: [{ ownerKind: "title", ownerId: w.film.id, durationSeconds: 100 }], done: true });
    expect(await has(w.member, w.film.id)).toBe(false);
  });

  it("only touches the profile that finished it", async () => {
    const w = await world();
    await db.insert(watchlistItems).values([{ viewerId: w.member.viewer.id, titleId: w.film.id }, { viewerId: w.admin.viewer.id, titleId: w.film.id }]);
    await dropFinished(db, w.member.viewer.id, { titleIds: [w.film.id] });
    expect([await has(w.member, w.film.id), await has(w.admin, w.film.id)]).toEqual([false, true]);
    void watchState;
  });
});
