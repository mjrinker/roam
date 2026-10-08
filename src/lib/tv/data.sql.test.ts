/** What the TV pages show, with library sharing, age limits and server boundaries applied. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { episodes, libraryMembers, seasons, watchState } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { PAGE_SIZE, continueWatching, libraryTitles, movieDetail, showDetail, tvLibraries, watchInfo, type TvScope } from "./data";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", access);
  const shows = await makeLibrary(db, server.id, "shows", access);
  const actor = (isAdmin = false): LibraryActor => ({ serverId: server.id, accountId: member.accountId, isAdmin });
  const scope = (viewer = adult): TvScope => ({ actor: actor(), viewer, viewerId: member.viewer.id });
  return { admin, server, member, movies, shows, actor, scope };
}

describe("tvLibraries", () => {
  it("lists movies and shows libraries, counts the rest, and leaves out libraries it can't see", async () => {
    const w = await world();
    await makeLibrary(db, w.server.id, "music", "everyone");
    await makeLibrary(db, w.server.id, "photos", "everyone");
    await makeLibrary(db, w.server.id, "movies", "restricted"); // not shared with this member
    const r = await tvLibraries(db, w.scope());
    expect(r.supported.map((l) => l.kind).sort()).toEqual(["movies", "shows"]);
    expect(r.unsupported).toBe(2);
  });
  it("shows a restricted library to an admin and to a member it was shared with", async () => {
    const w = await world("restricted");
    expect((await tvLibraries(db, w.scope())).supported).toHaveLength(0);
    await db.insert(libraryMembers).values({ libraryId: w.movies.id, serverId: w.server.id, accountId: w.member.accountId });
    expect((await tvLibraries(db, w.scope())).supported.map((l) => l.id)).toEqual([w.movies.id]);
    expect((await tvLibraries(db, { ...w.scope(), actor: w.actor(true) })).supported).toHaveLength(2);
  });
  it("keeps servers apart", async () => {
    const [a, b] = [await world(), await world()];
    expect((await tvLibraries(db, b.scope())).supported.map((l) => l.id)).not.toContain(a.movies.id);
  });
});

describe("libraryTitles", () => {
  it("pages by name, ignoring case, and says when there is more", async () => {
    const w = await world();
    const names = Array.from({ length: PAGE_SIZE + 6 }, (_, i) => (i % 2 ? `b${String(i).padStart(2, "0")}` : `A${String(i).padStart(2, "0")}`));
    for (const name of names) await makeTitle(db, w.movies.id, { kind: "movie", name });
    const one = await libraryTitles(db, w.scope(), w.movies.id, 1);
    const two = await libraryTitles(db, w.scope(), w.movies.id, 2);
    expect([one!.items.length, one!.hasMore, two!.items.length, two!.hasMore]).toEqual([PAGE_SIZE, true, 6, false]);
    const all = [...one!.items, ...two!.items].map((t) => t.name);
    expect(all).toEqual([...names].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
    expect((await libraryTitles(db, w.scope(), w.movies.id, 0))!.items).toHaveLength(PAGE_SIZE); // page numbers start at one
  });
  it("hides titles the profile's age limit forbids, and library kinds that have no TV interface, and other servers' libraries", async () => {
    const w = await world();
    await makeTitle(db, w.movies.id, { kind: "movie", name: "Cartoon", ratingAges: { ANY: 0 } });
    await makeTitle(db, w.movies.id, { kind: "movie", name: "Thriller", ratingAges: { ANY: 17 } });
    expect((await libraryTitles(db, w.scope(kid), w.movies.id, 1))!.items.map((t) => t.name)).toEqual(["Cartoon"]);
    expect((await libraryTitles(db, w.scope(), w.movies.id, 1))!.items).toHaveLength(2);
    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    expect(await libraryTitles(db, w.scope(), music.id, 1)).toBeNull();
    const other = await world();
    expect(await libraryTitles(db, w.scope(), other.movies.id, 1)).toBeNull();
  });
  it("is the same null for a restricted library the member can't see", async () => {
    const w = await world("restricted");
    expect(await libraryTitles(db, w.scope(), w.movies.id, 1)).toBeNull();
  });
});

describe("continueWatching", () => {
  const state = (viewerId: string, ownerKind: "title" | "episode", ownerId: string, over: Partial<typeof watchState.$inferInsert> = {}) =>
    db.insert(watchState).values({ viewerId, ownerKind, ownerId, positionSeconds: 300, durationSeconds: 3000, finished: false, ...over });

  it("lists started, unfinished movies and episodes, newest first, with progress", async () => {
    const w = await world();
    const m1 = await makeTitle(db, w.movies.id, { kind: "movie", name: "Old Movie", posterUrl: "https://img/m1.jpg" });
    const m2 = await makeTitle(db, w.movies.id, { kind: "movie", name: "Done", ratingAges: null });
    const m3 = await makeTitle(db, w.movies.id, { kind: "movie", name: "Never Started" });
    const { show, episodes: eps } = await makeShow(db, w.shows.id, 2, { name: "Great Show", posterUrl: "https://img/s.jpg" });
    await state(w.member.viewer.id, "title", m1.id, { updatedAt: new Date(Date.now() - 60_000) });
    await state(w.member.viewer.id, "title", m2.id, { finished: true });
    await state(w.member.viewer.id, "title", m3.id, { positionSeconds: 0 });
    await state(w.member.viewer.id, "episode", eps[1].id, { positionSeconds: 1500, durationSeconds: 3000 });
    const items = await continueWatching(db, w.scope());
    expect(items.map((i) => [i.kind, i.name])).toEqual([["episode", "Great Show"], ["title", "Old Movie"]]);
    expect(items[0]).toMatchObject({ meta: "S1 · E2 · Ep 2", progress: 0.5, posterUrl: "https://img/s.jpg" });
    expect(items[1].progress).toBeCloseTo(0.1);
    expect(show.id).toBeTruthy();
  });
  it("never includes another profile's progress, a hidden library's titles or a title the age limit forbids", async () => {
    const w = await world("restricted");
    const hidden = await makeTitle(db, w.movies.id, { kind: "movie", name: "Hidden" });
    await state(w.member.viewer.id, "title", hidden.id);
    expect(await continueWatching(db, w.scope())).toEqual([]);
    await db.insert(libraryMembers).values({ libraryId: w.movies.id, serverId: w.server.id, accountId: w.member.accountId });
    expect(await continueWatching(db, w.scope())).toHaveLength(1);
    expect(await continueWatching(db, w.scope(kid))).toEqual([]); // unrated, and this profile allows only rated
    const other = await makeAccount(db, "other");
    expect(await continueWatching(db, { ...w.scope(), viewerId: other.viewer.id })).toEqual([]);
  });
  it("respects the limit", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await state(w.member.viewer.id, "title", (await makeTitle(db, w.movies.id, { kind: "movie", name: `M${i}` })).id);
    expect(await continueWatching(db, w.scope(), 3)).toHaveLength(3);
  });
});

describe("movieDetail / showDetail", () => {
  it("finds a movie with where the profile left off, and only a movie", async () => {
    const w = await world();
    const m = await makeTitle(db, w.movies.id, { kind: "movie", name: "Film" });
    const { show } = await makeShow(db, w.shows.id, 1);
    expect((await movieDetail(db, w.scope(), m.id))!.resume).toBeNull();
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: m.id, positionSeconds: 100, durationSeconds: 1000 });
    expect((await movieDetail(db, w.scope(), m.id))!.resume).toEqual({ positionSeconds: 100, durationSeconds: 1000 });
    await db.update(watchState).set({ finished: true }).where(eq(watchState.ownerId, m.id));
    expect((await movieDetail(db, w.scope(), m.id))!.resume).toBeNull();
    expect(await movieDetail(db, w.scope(), show.id)).toBeNull();
  });
  it("hides a movie or show from a profile that may not see it, and from another server, with the same null as a missing id", async () => {
    const w = await world();
    const adultOnly = await makeTitle(db, w.movies.id, { kind: "movie", name: "R", ratingAges: { ANY: 17 } });
    const { show } = await makeShow(db, w.shows.id, 1, { ratingAges: { ANY: 17 } });
    const missing = "00000000-0000-4000-8000-0000000000aa";
    expect(await Promise.all([movieDetail(db, w.scope(kid), adultOnly.id), showDetail(db, w.scope(kid), show.id), movieDetail(db, w.scope(kid), missing)])).toEqual([null, null, null]);
    const other = await world();
    expect(await movieDetail(db, other.scope(), adultOnly.id)).toBeNull();
  });
  it("lists a show's seasons and one season's episodes in order with watched marks, falling back to the first season", async () => {
    const w = await world();
    const { show, season, episodes: eps } = await makeShow(db, w.shows.id, 3);
    const [s2] = await db.insert(seasons).values({ titleId: show.id, number: 2, boxFolderId: `bf-${Math.random()}` }).returning();
    await db.insert(episodes).values({ seasonId: s2.id, number: 1, name: "Second season" });
    await db.insert(watchState).values([
      { viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: eps[0].id, positionSeconds: 3000, durationSeconds: 3000, finished: true },
      { viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: eps[1].id, positionSeconds: 300, durationSeconds: 3000 },
    ]);
    const d = (await showDetail(db, w.scope(), show.id))!;
    expect([d.seasons, d.currentSeason]).toEqual([[season.number, 2], 1]);
    expect(d.episodes.map((e) => [e.number, e.watched, e.inProgress])).toEqual([[1, true, false], [2, false, true], [3, false, false]]);
    expect((await showDetail(db, w.scope(), show.id, 2))!.episodes.map((e) => e.name)).toEqual(["Second season"]);
    expect((await showDetail(db, w.scope(), show.id, 99))!.currentSeason).toBe(1);
  });
});

describe("watchInfo", () => {
  it("names a movie and sends Back to its page", async () => {
    const w = await world();
    const m = await makeTitle(db, w.movies.id, { kind: "movie", name: "Film", year: 1999 });
    expect(await watchInfo(db, w.scope(), "title", m.id)).toMatchObject({ title: "Film", subtitle: "1999", back: { kind: "title", id: m.id }, next: null });
  });
  it("finds the next episode in the season, then the first of the next season, then none", async () => {
    const w = await world();
    const { show, season, episodes: eps } = await makeShow(db, w.shows.id, 2);
    const [s2] = await db.insert(seasons).values({ titleId: show.id, number: season.number + 1, boxFolderId: `bf-${Math.random()}` }).returning();
    const [first2] = await db.insert(episodes).values({ seasonId: s2.id, number: 1 }).returning();
    expect((await watchInfo(db, w.scope(), "episode", eps[0].id))!.next).toEqual({ kind: "episode", id: eps[1].id });
    const last = (await watchInfo(db, w.scope(), "episode", eps[1].id))!;
    expect(last.next).toEqual({ kind: "episode", id: first2.id });
    expect(last).toMatchObject({ title: show.name, back: { kind: "show", id: show.id, season: season.number } });
    expect((await watchInfo(db, w.scope(), "episode", first2.id))!.next).toBeNull();
  });
  it("refuses what the profile may not watch, in the same way as something that doesn't exist", async () => {
    const w = await world("restricted");
    const m = await makeTitle(db, w.movies.id, { kind: "movie", name: "Hidden" });
    const { episodes: eps } = await makeShow(db, w.shows.id, 1);
    expect(await Promise.all([watchInfo(db, w.scope(), "title", m.id), watchInfo(db, w.scope(), "episode", eps[0].id), watchInfo(db, w.scope(), "title", "00000000-0000-4000-8000-0000000000aa")])).toEqual([null, null, null]);
  });
});
