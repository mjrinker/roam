/** The browse API through a device token: what it lists and opens, and what it keeps hidden. */
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

import { eq, inArray } from "drizzle-orm";
import { libraryMembers, mediaFiles, titles, viewers, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { saveSettings } from "@/lib/ownership/owners";
import { GET as servers } from "./servers/route";
import { GET as libs } from "./servers/[serverId]/libraries/route";
import { GET as home } from "./servers/[serverId]/home/route";
import { GET as items } from "./servers/[serverId]/libraries/[libraryId]/items/route";
import { GET as detail } from "./servers/[serverId]/titles/[id]/route";
import { GET as search } from "./servers/[serverId]/search/route";


autoFiles();
let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const req = (path = "/x") => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `admin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `member${++n}`);
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "The Film", year: 2001, overview: "A story.", runtimeSeconds: 5400, posterUrl: "https://img.example/f.jpg" });
  const { show, season, episodes } = await makeShow(db, shows.id, 3, { name: "The Show", year: 2010 });
  await as(member);
  return { admin, server, member, movies, shows, film, show, season, episodes, sid: { serverId: server.id } };
}

describe("access", () => {
  it("answers 401 with no token, 404 for a server you're not in or a bad id, and 409 when no profile is chosen yet", async () => {
    const w = await world();
    h.headers = {};
    for (const r of [await servers(), await libs(req(), ctx(w.sid)), await home(req(), ctx(w.sid)), await detail(req(), ctx({ ...w.sid, id: w.film.id })), await search(req("/x?q=a"), ctx(w.sid))]) expect(r.status).toBe(401);
    await as(w.member);
    const other = await world();
    await as(w.member);
    expect((await libs(req(), ctx({ serverId: other.server.id }))).status).toBe(404);
    expect((await libs(req(), ctx({ serverId: "nope" }))).status).toBe(404);
    expect((await detail(req(), ctx({ ...w.sid, id: other.film.id }))).status).toBe(404);
    // two profiles and none chosen
    const second = await makeAccount(db, `two${++n}`);
    await joinServer(db, w.server.id, second.accountId);
    await db.insert(viewers).values({ accountId: second.accountId, name: "Kid", role: "limited", sortOrder: 2 });
    const { token } = await createDeviceToken(db, { accountId: second.accountId, label: "TV" });
    h.headers = { authorization: `Bearer ${token}` };
    const blocked = await libs(req(), ctx(w.sid));
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).code).toBe("profile_required");
    expect((await servers()).status).toBe(200); // choosing a profile isn't needed to list servers
  });
});

describe("listing", () => {
  it("lists the account's servers, the libraries and how each is browsed", async () => {
    const w = await world();
    const list = await json(await servers());
    expect(list.servers).toEqual([{ id: w.server.id, name: expect.any(String), role: "viewer" }]);
    await makeLibrary(db, w.server.id, "ebooks", "everyone");
    const l = await json(await libs(req(), ctx(w.sid)));
    expect(l.libraries.map((x: { kind: string; style: string | null }) => [x.kind, x.style]).sort()).toEqual([["ebooks", null], ["movies", "grid"], ["shows", "grid"]]);
  });

  it("hides a library that isn't shared with this member", async () => {
    const w = await world();
    const secret = await makeLibrary(db, w.server.id, "movies", "restricted");
    expect((await json(await libs(req(), ctx(w.sid)))).libraries.some((x: { id: string }) => x.id === secret.id)).toBe(false);
    expect((await items(req(), ctx({ ...w.sid, libraryId: secret.id }))).status).toBe(404);
    await db.insert(libraryMembers).values({ libraryId: secret.id, serverId: w.server.id, accountId: w.member.accountId, grantedByAccountId: w.admin.accountId });
    expect((await items(req(), ctx({ ...w.sid, libraryId: secret.id }))).status).toBe(200);
  });

  it("pages a grid library by name and says when there are more", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await makeTitle(db, w.movies.id, { kind: "movie", name: `Extra ${String(i).padStart(2, "0")}` });
    const one = await json(await items(req("/x"), ctx({ ...w.sid, libraryId: w.movies.id })));
    expect(one.hasMore).toBe(true);
    expect(one.items).toHaveLength(24);
    expect(one.items[0]).toMatchObject({ type: "movie", name: "Extra 00", square: false });
    const two = await json(await items(req("/x?page=2"), ctx({ ...w.sid, libraryId: w.movies.id })));
    expect(two.items.map((i: { name: string }) => i.name)).toContain("The Film");
    expect(two.hasMore).toBe(false);
    const shows = await json(await items(req(), ctx({ ...w.sid, libraryId: w.shows.id })));
    expect(shows.items[0]).toMatchObject({ type: "show", id: w.show.id, subtitle: "2010" });
  });

  it("browses the folders of a video library", async () => {
    const w = await world();
    const vids = await makeLibrary(db, w.server.id, "video", "everyone");
    await makeTitle(db, vids.id, { kind: "movie", name: "Holiday", folderPath: "Trips" });
    await makeTitle(db, vids.id, { kind: "movie", name: "Top", folderPath: "" });
    const root = await json(await items(req(), ctx({ ...w.sid, libraryId: vids.id })));
    expect(root.folders).toEqual(["Trips"]);
    expect(root.items.map((i: { name: string }) => i.name)).toEqual(["Top"]);
    const trips = await json(await items(req("/x?path=Trips"), ctx({ ...w.sid, libraryId: vids.id })));
    expect(trips.items[0]).toMatchObject({ type: "movie", name: "Holiday" });
    expect((await items(req("/x?after=garbage"), ctx({ ...w.sid, libraryId: vids.id }))).status).toBe(400);
  });

  it("gives the home screen: continue watching with progress, what's new, the libraries and the unread count", async () => {
    const w = await world();
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: w.film.id, positionSeconds: 500, durationSeconds: 5000 });
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: w.episodes[1].id, positionSeconds: 100, durationSeconds: 1000 });
    const body = await json(await home(req(), ctx(w.sid)));
    expect(body.continueWatching.map((c: { type: string; progress: number }) => [c.type, c.progress]).sort()).toEqual([["episode", 0.1], ["movie", 0.1]]);
    expect(body.recentlyAdded.map((r: { type: string }) => r.type).sort()).toEqual(["movie", "show"]);
    expect(body.libraries).toHaveLength(2);
    expect(body.unreadNotifications).toBe(0);
    expect(body.server.id).toBe(w.server.id);
  });

  it("offers the next episode of a show being watched as up next", async () => {
    const w = await world();
    for (const e of w.episodes) await db.delete(mediaFiles).where(eq(mediaFiles.ownerId, e.id));
    for (const e of w.episodes) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: e.id, partIndex: 0, boxFileId: `up${++n}`, filename: "e.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 1000 });
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: w.episodes[0].id, positionSeconds: 1000, durationSeconds: 1000, finished: true });
    const body = await json(await home(req(), ctx(w.sid)));
    expect(body.upNext).toEqual([expect.objectContaining({ type: "episode", id: w.episodes[1].id, name: "The Show", subtitle: expect.stringContaining("E2") })]);
    expect(body.continueWatching).toEqual([]);
  });

  it("recommends nothing until something has been rated, then titles like the ones rated highly, and says which it was like", async () => {
    const w = await world();
    const { ratings } = await import("@/lib/db/schema");
    await db.update(titles).set({ genres: ["Drama"] }).where(eq(titles.id, w.film.id));
    const like = await makeTitle(db, w.movies.id, { kind: "movie", name: "Another Drama", year: 2003, genres: ["Drama"] });
    await db.delete(mediaFiles).where(inArray(mediaFiles.ownerId, [w.film.id, like.id]));
    await db.insert(mediaFiles).values([w.film.id, like.id].map((ownerId) => ({ ownerKind: "title" as const, ownerId, partIndex: 0, boxFileId: `rec${++n}${ownerId}`, filename: "f.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok" as const, durationSeconds: 100 })));
    expect((await json(await home(req(), ctx(w.sid)))).recommended).toEqual([]);
    await db.insert(ratings).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: w.film.id, halfStars: 10 });
    const body = await json(await home(req(), ctx(w.sid)));
    expect(body.recommended).toEqual([expect.objectContaining({ type: "movie", id: like.id, name: "Another Drama" })]);
    const t = await json(await detail(req(), ctx({ ...w.sid, id: w.film.id })));
    expect(t.similar).toEqual([expect.objectContaining({ id: like.id })]);
  });

  it("searches, and finds nothing for an empty query", async () => {
    const w = await world();
    const hit = await json(await search(req("/x?q=film"), ctx(w.sid)));
    expect(hit.items).toEqual([expect.objectContaining({ type: "movie", id: w.film.id, name: "The Film" })]);
    expect((await json(await search(req("/x?q=%20%20"), ctx(w.sid)))).items).toEqual([]);
  });
});

describe("a title", () => {
  it("is a movie with where you left off, how to play it, chapters, a parental guide and extras", async () => {
    const w = await world();
    await db.delete(mediaFiles).where(eq(mediaFiles.ownerId, w.film.id));
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: w.film.id, partIndex: 0, boxFileId: `b${++n}`, filename: "f.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 5400, chapters: [{ title: "One", startSeconds: 0 }, { title: "Two", startSeconds: 2000 }], contentCues: [{ startSeconds: 10, endSeconds: 30, category: "violence", severity: "high", channel: "both" }] });
    await db.update(viewers).set({ contentFilter: { violence: "medium" } }).where(eq(viewers.id, w.member.viewer.id));
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: w.film.id, positionSeconds: 1800, durationSeconds: 5400 });
    const m = await json(await detail(req(), ctx({ ...w.sid, id: w.film.id })));
    expect(m).toMatchObject({ type: "movie", name: "The Film", year: 2001, resume: { positionSeconds: 1800, durationSeconds: 5400 }, finished: false, play: { manifestPath: `/api/play/title/${w.film.id}` } });
    expect(m.chapters).toEqual([{ title: "One", startSeconds: 0 }, { title: "Two", startSeconds: 2000 }]);
    expect(m.guide.lines).toEqual([{ category: "violence", severity: "high", scenes: 1, seconds: 20, source: "file", skippedForYou: true }]);
    expect(m.ownership).toBeNull(); // not tracked here
  });

  it("is a show with a season's episodes, what to continue with, and a chosen season", async () => {
    const w = await world();
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: w.episodes[0].id, positionSeconds: 100, durationSeconds: 100, finished: true });
    const s = await json(await detail(req(), ctx({ ...w.sid, id: w.show.id })));
    expect(s).toMatchObject({ type: "show", season: 1, seasons: [1], continueEpisodeId: w.episodes[1].id });
    expect(s.episodes.map((e: { number: number; watched: boolean }) => [e.number, e.watched])).toEqual([[1, true], [2, false], [3, false]]);
    expect(s.episodes[0].playPath).toBe(`/api/play/episode/${w.episodes[0].id}`);
    expect((await json(await detail(req("/x?season=9"), ctx({ ...w.sid, id: w.show.id })))).season).toBe(1);
  });

  it("is an audiobook", async () => {
    const w = await world();
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const b = await makeTitle(db, books.id, { kind: "audiobook", name: "A Book", authors: ["Ann Author"], narrators: ["Ned"], seriesName: "Saga", seriesPosition: "2" });
    const body = await json(await detail(req(), ctx({ ...w.sid, id: b.id })));
    expect(body).toMatchObject({ type: "audiobook", authors: ["Ann Author"], narrators: ["Ned"], series: { name: "Saga", position: "2" }, play: { manifestPath: `/api/audiobooks/${b.id}/manifest` } });
  });

  it("carries who owns it when the server tracks that", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    const m = await json(await detail(req(), ctx({ ...w.sid, id: w.film.id })));
    expect(m.ownership).toMatchObject({ claimMode: "review", canChange: true, units: [{ iOwn: false, playable: true, owners: [] }] });
  });

  it("is not found for a title above this profile's age limit, a missing one, or a bad id", async () => {
    const w = await world();
    const adult = await makeTitle(db, w.movies.id, { kind: "movie", name: "Grown-up", ratingAges: { ANY: 17 } });
    const kid = await makeAccount(db, `kid${++n}`);
    await joinServer(db, w.server.id, kid.accountId);
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, kid.viewer.id));
    await as(kid);
    expect((await detail(req(), ctx({ ...w.sid, id: adult.id }))).status).toBe(404);
    expect((await detail(req(), ctx({ ...w.sid, id: "00000000-0000-4000-8000-0000000000aa" }))).status).toBe(404);
    expect((await detail(req(), ctx({ ...w.sid, id: "nope" }))).status).toBe(404);
    const grid = await json(await items(req(), ctx({ ...w.sid, libraryId: w.movies.id })));
    expect(grid.items.some((i: { name: string }) => i.name === "Grown-up")).toBe(false);
    expect((await json(await search(req("/x?q=grown"), ctx(w.sid)))).items).toEqual([]);
  });
});
