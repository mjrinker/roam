/** The shared TMDB cache: fetched once for every server, refreshed before it is six months old, cleared if it can't be. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  movie: vi.fn(),
  tv: vi.fn(),
  season: vi.fn(),
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/tmdb/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tmdb/client")>();
  return { ...original, getMovieDetails: h.movie, getTvShowDetails: h.tv, getSeasonEpisodes: h.season };
});

import { episodes, seasons, titles, tmdbCast, tmdbCrew, tmdbEntries } from "@/lib/db/schema";
import { TmdbHttpError } from "@/lib/tmdb/client";
import { clearExpired, DAY_MS, deleteUnreferencedEntries, FRESH_MS, getMovieDetails, getSeasonEpisodes, getTvShowDetails, HARD_MS, isStale, refreshEntry, refreshIfStale, staleEntries } from "./cache";
import { runTmdbRefresh } from "./refresh-job";
import { makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => {
  h.movie.mockReset();
  h.tv.mockReset();
  h.season.mockReset();
});

let nextId = 50_000;
const movieJson = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Film ${id}`,
  overview: `About ${id}`,
  poster_path: "/p.jpg",
  backdrop_path: "/b.jpg",
  runtime: 100,
  genres: [{ id: 1, name: "Drama", extra: "junk" }],
  adult: false,
  imdb_id: `tt${id}`,
  homepage: "https://junk.example",
  release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG", type: 3, note: "junk" }] }, { iso_3166_1: "GB", release_dates: [{ certification: "12A", type: 3 }] }] },
  credits: { cast: [{ id: 1, name: "Star", character: "Hero", profile_path: "/s.jpg", order: 0 }], crew: [{ id: 7, name: "Dir", job: "Director", profile_path: null }, { id: 8, name: "Grip", job: "Best Boy" }] },
  ...over,
});
const tvJson = (id: number) => ({
  id,
  name: `Show ${id}`,
  overview: `Show about ${id}`,
  poster_path: "/sp.jpg",
  backdrop_path: "/sb.jpg",
  genres: [{ id: 2, name: "Comedy" }],
  number_of_seasons: 1,
  content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-14" }] },
  external_ids: { imdb_id: `tt${id}` },
  credits: { cast: [{ id: 2, name: "Lead", character: "Boss", order: 0 }], crew: [{ id: 9, name: "Creator Person", job: "Creator" }] },
});
const aged = (kind: "movie" | "tv" | "tv-season", tmdbId: number, days: number, season = 0) =>
  db.update(tmdbEntries).set({ fetchedAt: new Date(Date.now() - days * DAY_MS) }).where(and(eq(tmdbEntries.kind, kind), eq(tmdbEntries.tmdbId, tmdbId), eq(tmdbEntries.season, season)));
const entryOf = async (kind: "movie" | "tv" | "tv-season", tmdbId: number, season = 0) => (await db.select().from(tmdbEntries).where(and(eq(tmdbEntries.kind, kind), eq(tmdbEntries.tmdbId, tmdbId), eq(tmdbEntries.season, season))))[0];

async function lib(kind: "movies" | "shows" = "movies") {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  return makeLibrary(db, server.id, kind, "everyone");
}

describe("reading TMDB details through the shared cache", () => {
  it("fetches once for everyone, keeps only what Roam uses, and puts the cast and crew in rows", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    const first = await getMovieDetails(id, { append: ["release_dates"] });
    expect(first).toMatchObject({ id, overview: `About ${id}`, imdb_id: `tt${id}` });
    expect(h.movie).toHaveBeenCalledWith(id, { append: ["release_dates", "credits"] });
    // only the parts Roam uses are stored
    const stored = (await entryOf("movie", id)).payload as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["adult", "backdrop_path", "belongs_to_collection", "genres", "id", "imdb_id", "overview", "poster_path", "release_dates", "release_date", "runtime", "title"].sort().filter((k) => k in stored));
    expect(JSON.stringify(stored)).not.toMatch(/junk|credits|homepage/);
    expect((stored.release_dates as { results: unknown[] }).results).toHaveLength(2);
    expect(await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, id))).toHaveLength(1);
    expect((await db.select().from(tmdbCrew).where(eq(tmdbCrew.tmdbId, id))).map((c) => c.job)).toEqual(["Director"]); // Best Boy isn't a key job
    // the second server (or the second read) doesn't ask TMDB again
    expect(await getMovieDetails(id)).toEqual(first);
    expect(h.movie).toHaveBeenCalledTimes(1);
  });
  it("keeps movies and shows with the same TMDB id apart", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    h.tv.mockResolvedValue(tvJson(id));
    expect((await getMovieDetails(id)).title).toBe(`Film ${id}`);
    expect((await getTvShowDetails(id)).name).toBe(`Show ${id}`);
    expect((await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, id))).map((c) => [c.kind, c.name]).sort()).toEqual([["movie", "Star"], ["tv", "Lead"]]);
  });
  it("caches a season's episodes too, trimmed", async () => {
    const id = ++nextId;
    h.season.mockResolvedValue([{ id: 1, episode_number: 1, name: "Pilot", overview: "o", still_path: "/s.jpg", runtime: 22, junk: "x" }]);
    expect((await getSeasonEpisodes(id, 3)).map((e) => e.name)).toEqual(["Pilot"]);
    await getSeasonEpisodes(id, 3);
    expect(h.season).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await entryOf("tv-season", id, 3)).payload)).not.toContain("junk");
  });
});

describe("how old an entry may be", () => {
  it("still serves an entry past five months (it is refreshed on view and daily), refetches one past six, and falls back to the old one only while it is allowed", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    await getMovieDetails(id);
    await aged("movie", id, 160);
    expect(await isStale("movie", id)).toBe(true);
    expect((await getMovieDetails(id)).overview).toBe(`About ${id}`);
    expect(h.movie).toHaveBeenCalledTimes(1); // served from the entry, not refetched

    h.movie.mockRejectedValue(new Error("TMDB down"));
    await aged("movie", id, 190);
    await expect(getMovieDetails(id)).rejects.toThrow("TMDB down"); // too old to show, and can't be refreshed
    await aged("movie", id, 160);
    expect((await getMovieDetails(id)).id).toBe(id); // a failed ordinary read within the limit falls back to the entry
    await expect(getMovieDetails(id, { force: true })).rejects.toThrow("TMDB down"); // a forced refresh says it failed
  });
  it("is fresh just under five months and stale just over", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    await getMovieDetails(id);
    await db.update(tmdbEntries).set({ fetchedAt: new Date(Date.now() - FRESH_MS + 60_000) }).where(eq(tmdbEntries.tmdbId, id));
    expect(await isStale("movie", id)).toBe(false);
    await db.update(tmdbEntries).set({ fetchedAt: new Date(Date.now() - FRESH_MS - 60_000) }).where(eq(tmdbEntries.tmdbId, id));
    expect(await isStale("movie", id)).toBe(true);
    expect(await isStale("movie", id + 999_999)).toBe(false); // nothing cached: nothing to refresh
  });
});

describe("refreshing an entry", () => {
  it("updates every matched title that uses it, on any server, and leaves pending titles, names and years alone", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    await getMovieDetails(id);
    const a = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Folder name A", year: 1999, tmdbId: id, metadataStatus: "matched", overview: "old", posterUrl: "old", ratingAges: { US: 17 }, imdbId: "ttOLD", externalRatingsAttemptedAt: new Date(), imdbRating: 5 });
    const b = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Folder name B", tmdbId: id, metadataStatus: "manual", overview: "old" });
    const pending = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Not matched yet", tmdbId: id, metadataStatus: "pending", overview: "old" });
    h.movie.mockResolvedValue(movieJson(id, { overview: "Refreshed text", imdb_id: "ttNEW", release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13", type: 3 }] }] } }));
    expect(await refreshEntry("movie", id)).toBe("refreshed");
    const rows = await Promise.all([a, b, pending].map(async (t) => (await db.select().from(titles).where(eq(titles.id, t.id)))[0]));
    expect(rows[0]).toMatchObject({ name: "Folder name A", year: 1999, overview: "Refreshed text", posterUrl: expect.stringContaining("/p.jpg"), imdbId: "ttNEW", certifications: { US: "PG-13" }, ratingAges: { US: 13 }, externalRatingsAttemptedAt: null });
    expect(rows[1]).toMatchObject({ name: "Folder name B", overview: "Refreshed text" });
    expect(rows[2]).toMatchObject({ overview: "old" });
    expect(Date.now() - (await entryOf("movie", id)).fetchedAt.getTime()).toBeLessThan(60_000);
  });
  it("keeps OMDb scores when the IMDb id didn't change", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    const t = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Same imdb", tmdbId: id, metadataStatus: "matched", imdbId: `tt${id}`, externalRatingsAttemptedAt: new Date("2026-01-01") });
    await refreshEntry("movie", id);
    expect((await db.select().from(titles).where(eq(titles.id, t.id)))[0].externalRatingsAttemptedAt).not.toBeNull();
  });
  it("refreshes a show, its cached seasons' episodes (keeping names already there), and its cast", async () => {
    const id = ++nextId;
    h.tv.mockResolvedValue(tvJson(id));
    h.season.mockResolvedValue([{ id: 11, episode_number: 1, name: "TMDB name", overview: "old", still_path: "/old.jpg", runtime: 20 }]);
    const l = await lib("shows");
    const { show, episodes: eps } = await makeShow(db, l.id, 2, { name: "Show", tmdbId: id, metadataStatus: "matched" });
    await db.update(episodes).set({ name: "Name from a file" }).where(eq(episodes.id, eps[0].id));
    await getTvShowDetails(id);
    await getSeasonEpisodes(id, 1);
    h.tv.mockResolvedValue({ ...tvJson(id), overview: "New show text", credits: { cast: [{ id: 3, name: "New Lead", order: 0 }], crew: [] } });
    h.season.mockResolvedValue([{ id: 11, episode_number: 1, name: "TMDB name", overview: "New episode text", still_path: "/new.jpg", runtime: 25 }]);
    expect(await refreshEntry("tv", id)).toBe("refreshed");
    expect((await db.select().from(titles).where(eq(titles.id, show.id)))[0]).toMatchObject({ overview: "New show text", ratingAges: { US: 13 } });
    expect((await db.select().from(episodes).where(eq(episodes.id, eps[0].id)))[0]).toMatchObject({ name: "Name from a file", overview: "New episode text", stillUrl: expect.stringContaining("/new.jpg"), runtimeSeconds: 1500, tmdbId: 11 });
    expect((await db.select().from(tmdbCast).where(and(eq(tmdbCast.kind, "tv"), eq(tmdbCast.tmdbId, id)))).map((c) => c.name)).toEqual(["New Lead"]);
    void seasons;
  });
  it("says missing when TMDB no longer has it (and stops asking), and failed when it can't be reached (and tries again)", async () => {
    const gone = ++nextId;
    const flaky = ++nextId;
    h.movie.mockResolvedValue(movieJson(gone));
    await getMovieDetails(gone);
    h.movie.mockResolvedValue(movieJson(flaky));
    await getMovieDetails(flaky);
    await aged("movie", gone, 160);
    await aged("movie", flaky, 161);
    h.movie.mockImplementation(async (id: number) => {
      if (id === gone) throw new TmdbHttpError("/movie", 404);
      throw new Error("network");
    });
    expect(await refreshEntry("movie", gone)).toBe("missing");
    expect(await refreshEntry("movie", flaky)).toBe("failed");
    expect((await entryOf("movie", gone)).missingAt).not.toBeNull();
    const due = (await staleEntries(1000)).map((e) => e.tmdbId);
    expect(due).toContain(flaky);
    expect(due).not.toContain(gone);
  });
});

describe("refreshing when a page is opened", () => {
  it("refreshes a stale entry before returning, not a fresh one, and gives up waiting if TMDB is slow", async () => {
    const id = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    await getMovieDetails(id);
    h.movie.mockClear();
    await refreshIfStale("movie", id);
    expect(h.movie).not.toHaveBeenCalled();
    await aged("movie", id, 160);
    await refreshIfStale("movie", id);
    expect(h.movie).toHaveBeenCalledTimes(1);
    expect(await isStale("movie", id)).toBe(false);

    await aged("movie", id, 160);
    h.movie.mockImplementation(() => new Promise((r) => setTimeout(() => r(movieJson(id)), 400)));
    const started = Date.now();
    await refreshIfStale("movie", id, 50);
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("the backstop and the clean-up", () => {
  it("clears an entry that couldn't be refreshed within six months: its cast, crew and what it gave titles, but never an age rating", async () => {
    const id = ++nextId;
    const fresh = ++nextId;
    h.movie.mockResolvedValue(movieJson(id));
    await getMovieDetails(id);
    h.movie.mockResolvedValue(movieJson(fresh));
    await getMovieDetails(fresh);
    const t = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Old", tmdbId: id, metadataStatus: "matched", overview: "text", posterUrl: "p", backdropUrl: "b", genres: ["Drama"], certifications: { US: "R" }, ratingAges: { US: 17 } });
    const keep = await makeTitle(db, (await lib()).id, { kind: "movie", name: "Recent", tmdbId: fresh, metadataStatus: "matched", overview: "text" });
    await aged("movie", id, Math.ceil(HARD_MS / DAY_MS) + 2);
    expect(await clearExpired()).toBe(1);
    expect((await entryOf("movie", id)).payload).toEqual({});
    expect(await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, id))).toEqual([]);
    expect(await db.select().from(tmdbCrew).where(eq(tmdbCrew.tmdbId, id))).toEqual([]);
    expect((await db.select().from(titles).where(eq(titles.id, t.id)))[0]).toMatchObject({ overview: null, posterUrl: null, backdropUrl: null, genres: [], certifications: { US: "R" }, ratingAges: { US: 17 } });
    expect((await db.select().from(titles).where(eq(titles.id, keep.id)))[0].overview).toBe("text");
    expect(await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, fresh))).toHaveLength(1);
    expect(await clearExpired()).toBe(0); // nothing left to clear
    // a cleared entry is fetched again the next time it is asked for, and refreshing it restores the titles
    h.movie.mockResolvedValue(movieJson(id, { overview: "Back again" }));
    expect(await refreshEntry("movie", id)).toBe("refreshed");
    expect((await db.select().from(titles).where(eq(titles.id, t.id)))[0].overview).toBe("Back again");
  });
  it("clears a season's episode text the same way", async () => {
    const id = ++nextId;
    h.season.mockResolvedValue([{ id: 1, episode_number: 1, name: "Pilot", overview: "o", still_path: "/s.jpg" }]);
    const { episodes: eps } = await makeShow(db, (await lib("shows")).id, 1, { name: "S", tmdbId: id, metadataStatus: "matched" });
    await db.update(episodes).set({ name: "Pilot", overview: "o", stillUrl: "x" }).where(eq(episodes.id, eps[0].id));
    await getSeasonEpisodes(id, 1);
    await aged("tv-season", id, 200, 1);
    await clearExpired();
    expect((await db.select().from(episodes).where(eq(episodes.id, eps[0].id)))[0]).toMatchObject({ name: "Pilot", overview: null, stillUrl: null });
  });
  it("forgets entries no title uses, keeping any a title of the right kind still uses", async () => {
    const used = ++nextId;
    const orphan = ++nextId;
    const wrongKind = ++nextId;
    for (const id of [used, orphan, wrongKind]) h.movie.mockResolvedValueOnce(movieJson(id));
    await getMovieDetails(used);
    await getMovieDetails(orphan);
    await getMovieDetails(wrongKind);
    const l = await lib();
    await makeTitle(db, l.id, { kind: "movie", name: "Uses it", tmdbId: used, metadataStatus: "matched" });
    await makeTitle(db, l.id, { kind: "show", name: "Show with the movie's id", tmdbId: wrongKind, metadataStatus: "matched" }); // a show isn't the movie
    await deleteUnreferencedEntries();
    expect(await entryOf("movie", used)).toBeDefined();
    expect(await entryOf("movie", orphan)).toBeUndefined();
    expect(await entryOf("movie", wrongKind)).toBeUndefined();
    expect(await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, orphan))).toEqual([]);
    expect(await db.select().from(tmdbCast).where(eq(tmdbCast.tmdbId, used))).toHaveLength(1);
  });
});

describe("the daily job", () => {
  it("refreshes the oldest stale entries first up to its limit, and reports what it did", async () => {
    const ids = [++nextId, ++nextId, ++nextId];
    const l = await lib();
    for (const id of ids) {
      h.movie.mockResolvedValueOnce(movieJson(id));
      await getMovieDetails(id);
      await makeTitle(db, l.id, { kind: "movie", name: `T${id}`, tmdbId: id, metadataStatus: "matched" });
    }
    await aged("movie", ids[0], 170);
    await aged("movie", ids[1], 190);
    await aged("movie", ids[2], 10); // fresh: not touched
    h.movie.mockImplementation(async (id: number) => {
      if (id === ids[1]) throw new Error("network");
      return movieJson(id, { overview: "daily" });
    });
    const summary = await runTmdbRefresh({ limit: 10 });
    expect(summary).toMatchObject({ refreshed: 1, failed: 1, missing: 0 });
    expect(summary.cleared).toBeGreaterThanOrEqual(1); // the one that couldn't be refreshed was past six months
    expect((await db.select().from(titles).where(eq(titles.tmdbId, ids[0])))[0].overview).toBe("daily");
    expect((await entryOf("movie", ids[2])).fetchedAt.getTime()).toBeLessThan(Date.now() - 5 * DAY_MS); // untouched
    const limited = await runTmdbRefresh({ limit: 0 });
    expect(limited.refreshed + limited.failed + limited.missing).toBe(0);
  });
});
