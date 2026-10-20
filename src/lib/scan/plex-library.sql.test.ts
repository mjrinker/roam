/**
 * A library laid out the way Plex wants, scanned: editions and versions, loose movie files, specials, date-named, loose and hinted episodes,
 * extras, subtitles, and the formats a browser can't play. The folder tree is a fake storage; TMDB is faked too.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: new Map<string, { id: string; name: string; kind: "file" | "folder"; sizeBytes?: number }[]>(),
  text: new Map<string, string>(),
  seasons: new Map<number, { id: number; episode_number: number; name: string; air_date?: string }[]>(),
  tvdbCalls: [] as number[],
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/tmdb/client", () => ({
  searchMovie: async () => null,
  searchTvShow: async () => ({ id: 500 }),
  findTmdbIdByImdbId: async () => null,
  findTmdbShowIdByTvdbId: async (id: number) => (h.tvdbCalls.push(id), 777),
  tmdbImageUrl: () => null,
}));
vi.mock("@/lib/tmdb/cache", () => ({
  getMovieDetails: async () => {
    throw new Error("none");
  },
  getTvShowDetails: async (id: number) => ({ id, overview: "", poster_path: null, backdrop_path: null, genres: [], content_ratings: { results: [] }, external_ids: {} }),
  getSeasonEpisodes: async (_id: number, season: number) => h.seasons.get(season) ?? [],
  refreshEntry: async () => undefined,
}));

import { episodes, mediaFiles, seasons, titleExtras, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { syncMovieFolder, syncShowFolder, syncStandaloneMovies } from "./scanner";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.tree.clear();
  h.text.clear();
  h.seasons.clear();
  h.tvdbCalls.length = 0;
});

let n = 0;
const f = (name: string, size = 50_000_000): StorageEntry => ({ id: `f${++n}-${name}`, name, kind: "file", sizeBytes: size }) as StorageEntry;
const d = (name: string, children: StorageEntry[] = []): StorageEntry => {
  const e = { id: `d${++n}-${name}`, name, kind: "folder" } as StorageEntry;
  h.tree.set(e.id, children);
  return e;
};
const provider = {
  listFolder: async (id: string) => h.tree.get(id) ?? [],
  fetchByteRange: async (id: string, start: number, end: number) => new TextEncoder().encode(h.text.get(id) ?? "").slice(start, end + 1).buffer,
} as unknown as StorageProvider;

async function library(kind: "movies" | "shows") {
  const owner = await makeAccount(db, `o${++n}`);
  const server = await makeServer(db, owner.accountId);
  return makeLibrary(db, server.id, kind, "everyone");
}
const titlesOf = async (libraryId: string) => (await db.select().from(titles).where(eq(titles.libraryId, libraryId)).orderBy(asc(titles.name)));
const filesOf = async (titleId: string) => (await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId))).orderBy(asc(mediaFiles.versionLabel), asc(mediaFiles.partIndex))).map((r) => `${r.versionLabel || "-"}:${r.partIndex}:${r.filename}`);

describe("movies in their own folders", () => {
  it("versions with any text are versions, not parts of one long film", async () => {
    const lib = await library("movies");
    const folder = d("Heat (1995)", [f("Heat (1995).mp4"), f("Heat (1995) - Hevc.mp4"), f("Heat (1995) - 1080p - pt1.mp4"), f("Heat (1995) - 1080p - pt2.mp4"), f("poster.jpg", 1000)]);
    await syncMovieFolder(provider, lib.id, folder);
    const [heat] = await titlesOf(lib.id);
    expect(heat.name).toBe("Heat");
    expect(await filesOf(heat.id)).toEqual(["-:0:Heat (1995).mp4", "1080p:0:Heat (1995) - 1080p - pt1.mp4", "1080p:1:Heat (1995) - 1080p - pt2.mp4", "hevc:0:Heat (1995) - Hevc.mp4"]);
  });

  it("editions in one folder are separate titles, and one that is taken away is removed", async () => {
    const lib = await library("movies");
    const kids = [f("Blade Runner (1982).mp4"), f("Blade Runner (1982) {edition-Director's Cut}.mp4"), f("Blade Runner (1982).1080p.h264 {edition-Final Cut}.mp4"), f("Blade Runner (1982).4k.hevc {edition-Final Cut}.mp4")];
    const folder = d("Blade Runner (1982)", kids);
    await syncMovieFolder(provider, lib.id, folder);
    const all = await titlesOf(lib.id);
    expect(all.map((t) => t.name)).toEqual(["Blade Runner", "Blade Runner (Director's Cut)", "Blade Runner (Final Cut)"]);
    const final = all.find((t) => t.name.endsWith("(Final Cut)"))!;
    expect(await filesOf(final.id)).toEqual(["1080p h264:0:Blade Runner (1982).1080p.h264 {edition-Final Cut}.mp4", "4k hevc:0:Blade Runner (1982).4k.hevc {edition-Final Cut}.mp4"]);
    expect(all.every((t) => t.year === 1982)).toBe(true);
    // A rescan changes nothing; taking an edition's files away removes its title.
    await syncMovieFolder(provider, lib.id, folder);
    expect(await titlesOf(lib.id)).toHaveLength(3);
    h.tree.set(folder.id, [kids[0], kids[1]]);
    await syncMovieFolder(provider, lib.id, folder);
    expect((await titlesOf(lib.id)).map((t) => t.name)).toEqual(["Blade Runner", "Blade Runner (Director's Cut)"]);
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, final.id))).toEqual([]);
  });

  it("a folder named for an edition makes every file in it that edition, and the folder's id keeps the title", async () => {
    const lib = await library("movies");
    const folder = d("Blade Runner (1982) {edition-Final Cut}", [f("Blade Runner (1982) {edition-Final Cut}.mkv"), f("Blade Runner (1982) {edition-Final Cut}.mp4")]);
    await syncMovieFolder(provider, lib.id, folder);
    const [t] = await titlesOf(lib.id);
    expect([t.name, t.boxFolderId]).toEqual(["Blade Runner (Final Cut)", folder.id]);
    expect(await filesOf(t.id)).toEqual(["-:0:Blade Runner (1982) {edition-Final Cut}.mp4"]);
  });

  it("extras go with the main title, and formats a browser can't play are counted, not hidden", async () => {
    const lib = await library("movies");
    const extras = d("Trailers", [f("Teaser Trailer.mp4")]);
    const folder = d("Avatar (2009)", [f("Avatar (2009).mkv"), f("Avatar (2009).mp4"), f("Teaser-trailer.mp4"), extras]);
    let skipped = 0;
    await syncMovieFolder(provider, lib.id, folder, (k) => (skipped += k));
    const [avatar] = await titlesOf(lib.id);
    expect(await filesOf(avatar.id)).toEqual(["-:0:Avatar (2009).mp4"]);
    expect(skipped).toBe(1);
    expect((await db.select().from(titleExtras).where(eq(titleExtras.titleId, avatar.id))).map((e) => e.category).sort()).toEqual(["trailers", "trailers"]);
  });
});

describe("movies loose in the library folder", () => {
  it("each movie, with its versions, editions and parts, without a folder of its own", async () => {
    const lib = await library("movies");
    const root = [
      f("Avatar (2009).mp4"),
      f("Batman Begins (2005) {tmdb-272}.mp4"),
      f("Batman Begins (2005) - 1080p.mp4"),
      f("Blade Runner (1982).mp4"),
      f("Blade Runner (1982) {edition-Director's Cut}.mp4"),
      f("The Dark Knight (2008) - pt2.mp4"),
      f("The Dark Knight (2008) - pt1.mp4"),
      f("Avatar (2009).en.srt", 5000),
      f("notes.txt", 10),
      f("Old Film (1950).avi"),
    ];
    let skipped = 0;
    const added = await syncStandaloneMovies(provider, lib.id, root, (k) => (skipped += k));
    expect(added).toBe(5);
    expect(skipped).toBe(1);
    const all = await titlesOf(lib.id);
    expect(all.map((t) => `${t.name}|${t.year}`)).toEqual(["Avatar|2009", "Batman Begins|2005", "Blade Runner|1982", "Blade Runner (Director's Cut)|1982", "The Dark Knight|2008"]);
    expect(await filesOf(all.find((t) => t.name === "Batman Begins")!.id)).toEqual(["-:0:Batman Begins (2005) {tmdb-272}.mp4", "1080p:0:Batman Begins (2005) - 1080p.mp4"]);
    expect(await filesOf(all.find((t) => t.name === "The Dark Knight")!.id)).toEqual(["-:0:The Dark Knight (2008) - pt1.mp4", "-:1:The Dark Knight (2008) - pt2.mp4"]);
    // Scanning again finds the same movies.
    expect(await syncStandaloneMovies(provider, lib.id, root)).toBe(0);
    expect(await titlesOf(lib.id)).toHaveLength(5);
  });
});

describe("posters kept beside the media", () => {
  const withBytes = (name: string) => {
    const e = f(name, 9);
    h.text.set(e.id, "\u00ff\u00d8poster");
    return e;
  };
  it("a movie's folder poster, a loose movie's same-named picture and a show's poster replace TMDB's", async () => {
    const movies = await library("movies");
    await syncMovieFolder(provider, movies.id, d("Batman Begins (2005)", [f("Batman Begins (2005).mp4"), withBytes("poster.jpg")]));
    await syncStandaloneMovies(provider, movies.id, [f("Avatar (2009).mp4"), withBytes("Avatar (2009).jpg"), f("Heat (1995).mp4")]);
    const all = await titlesOf(movies.id);
    const poster = (name: string) => all.find((t) => t.name === name)!.posterUrl;
    expect(poster("Batman Begins")).toMatch(/^\/api\/titles\/[0-9a-f-]+\/artwork\?v=\d+$/);
    expect(poster("Avatar")).toMatch(/\/artwork\?v=/);
    expect(poster("Heat")).toBeNull();
    const shows = await library("shows");
    await syncShowFolder(provider, shows.id, d("Heroes (2006)", [withBytes("show.png"), d("Season 01", [f("Heroes (2006) - s01e01.mp4")])]));
    expect((await titlesOf(shows.id))[0].posterUrl).toMatch(/\/artwork\?v=/);
  });
});

describe("TV shows", () => {
  const ep = (number: number, name: string, air_date?: string) => ({ id: 1000 + number, episode_number: number, name, air_date });

  it("reads Specials as season 0, any dash, dots, brackets and a multi-episode file", async () => {
    const lib = await library("shows");
    h.seasons.set(1, [ep(1, "One"), ep(2, "Two"), ep(3, "Three"), ep(4, "Four")]);
    const show = d("Grey's Anatomy (2005) {tvdb-73244}", [
      d("Specials", [f("Grey's Anatomy (2005) – s00e01 – Straight to the Heart.mp4")]),
      d("Season 01", [f("Grey's Anatomy (2005) - s01e01 - pt1.mp4"), f("Grey's Anatomy (2005) - s01e01 - pt2.mp4"), f("Grey's.Anatomy.S01E02.720p.WEB.mp4"), f("Grey's Anatomy (2005) - s01e03-e04 [1080p Bluray].mp4"), f("Grey's Anatomy (2005) - s01e01.mkv")]),
    ]);
    let skipped = 0;
    await syncShowFolder(provider, lib.id, show, (k) => (skipped += k));
    expect(h.tvdbCalls).toEqual([73244]);
    const [title] = await titlesOf(lib.id);
    expect(title).toMatchObject({ name: "Grey's Anatomy", year: 2005, tmdbId: 777 });
    const rows = await db.select({ season: seasons.number, episode: episodes.number, name: episodes.name }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, title.id)).orderBy(asc(seasons.number), asc(episodes.number));
    expect(rows.map((r) => `${r.season}x${r.episode}`)).toEqual(["0x1", "1x1", "1x2", "1x3", "1x4"]);
    expect(rows[0].name).toBe("Straight to the Heart");
    expect(skipped).toBe(1);
  });

  it("episodes named by date are found by the day TMDB says they aired", async () => {
    const lib = await library("shows");
    h.seasons.set(8, [ep(41, "Elijah Wood", "2011-11-15"), ep(42, "Someone Else", "2011-11-16"), ep(43, "Third", "2011-11-17")]);
    const show = d("The Colbert Report (2005)", [d("Season 08", [f("The Colbert Report (2005) - 2011-11-15 - Elijah Wood.mp4"), f("The Colbert Report (2005) - 16-11-2011 - x.mp4"), f("The Colbert Report (2005) - 2011.11.17.mp4"), f("The Colbert Report (2005) - 2011-12-25.mp4")])]);
    await syncShowFolder(provider, lib.id, show);
    const [title] = await titlesOf(lib.id);
    const rows = await db.select({ episode: episodes.number }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, title.id)).orderBy(asc(episodes.number));
    expect(rows.map((r) => r.episode)).toEqual([41, 42, 43]);
  });

  it("episodes loose in the show folder are numbered by their names, with no season folder", async () => {
    const lib = await library("shows");
    const show = d("Heroes (2006)", [f("Heroes (2006) - s01e01 - Genesis.mp4"), f("Heroes (2006) - s02e01 - Four Months Later.mp4"), d("Season 01", [f("Heroes (2006) - s01e02 - Don't Look Back.mp4")])]);
    await syncShowFolder(provider, lib.id, show);
    const [title] = await titlesOf(lib.id);
    const rows = await db.select({ season: seasons.number, episode: episodes.number }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, title.id)).orderBy(asc(seasons.number), asc(episodes.number));
    expect(rows.map((r) => `${r.season}x${r.episode}`)).toEqual(["1x1", "1x2", "2x1"]);
  });

  it(".plexmatch names the series, numbers files with tricky names, and a season folder's own file sets its season", async () => {
    const lib = await library("shows");
    const root = f(".plexmatch", 200);
    h.text.set(root.id, "Title: Cool Show\nYear: 2018\nep: SP01: Bonus Clip.mp4\nep: Season 2/Behind/Clip.mp4: ignored\n");
    const seasonHint = f(".plexmatch", 100);
    h.text.set(seasonHint.id, "season: 3\nep: 01: Pilot Of Three.mp4\npattern: Part {e} of three.mp4\n");
    const show = d("coolshowfolder", [root, f("Bonus Clip.mp4"), d("Extra Stuff", [seasonHint, f("Pilot Of Three.mp4"), f("Part 2 of three.mp4")])]);
    await syncShowFolder(provider, lib.id, show);
    const [title] = await titlesOf(lib.id);
    expect(title).toMatchObject({ name: "Cool Show", year: 2018 });
    const rows = await db.select({ season: seasons.number, episode: episodes.number }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, title.id)).orderBy(asc(seasons.number), asc(episodes.number));
    expect(rows.map((r) => `${r.season}x${r.episode}`)).toEqual(["0x1", "3x1", "3x2"]);
  });

  it("extras in the show folder, in a season folder and beside episodes, with numbered suffixes", async () => {
    const lib = await library("shows");
    const show = d("Game of Thrones (2011)", [
      d("Trailers", [f("Trailer 1.mp4")]),
      d("Season 01", [f("Game of Thrones - S01E01 - Winter is Coming.mp4"), f("Game of Thrones - S01E01 - Winter is Coming-deleted1.mp4"), f("Game of Thrones - S01E01 - Winter is Coming-deleted2.mp4"), d("Behind The Scenes", [f("A look at season 1.mp4")])]),
    ]);
    await syncShowFolder(provider, lib.id, show);
    const [title] = await titlesOf(lib.id);
    expect((await db.select().from(titleExtras).where(eq(titleExtras.titleId, title.id))).map((e) => e.category).sort()).toEqual(["behindthescenes", "deleted", "deleted", "trailers"]);
    const rows = await db.select({ episode: episodes.number }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, title.id));
    expect(rows).toHaveLength(1); // the extras are not episodes
  });
});
