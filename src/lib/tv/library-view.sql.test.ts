/** Sorting and narrowing a TV library: by title, year or when it arrived; by genre, by what hasn't been watched, by who owns it; and jumping to a letter. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { mediaFiles, titles, watchState } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { assignOwners, saveSettings } from "@/lib/ownership/owners";
import { syncSeriesCollections } from "@/lib/collections/sync";
import { PAGE_SIZE, libraryGenres, libraryTitles, pageForLetter, type TvScope } from "./data";
import { DEFAULT_OPTIONS, type LibraryOptions } from "./library-options";

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
const opts = (o: Partial<LibraryOptions>): LibraryOptions => ({ ...DEFAULT_OPTIONS, ...o });

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: member.accountId, isAdmin: false };
  const scope = (viewer = adult): TvScope => ({ actor, viewer, viewerId: member.viewer.id });
  const film = (name: string, over: Partial<typeof titles.$inferInsert> = {}) => makeTitle(db, movies.id, { kind: "movie", name, ...over });
  const names = async (o: Partial<LibraryOptions>, libraryId = movies.id, page = 1, viewer = adult) => (await libraryTitles(db, scope(viewer), libraryId, page, opts(o)))!.items.map((i) => i.name);
  return { admin, server, member, movies, shows, scope, film, names };
}

describe("sorting", () => {
  it("is by title by default, by year (newest first, undated last) or by when it was added", async () => {
    const w = await world();
    await w.film("Charlie", { year: 2001, addedAt: new Date("2026-01-03") });
    await w.film("alpha", { year: 2015, addedAt: new Date("2026-01-01") });
    await w.film("Bravo", { year: null, addedAt: new Date("2026-01-02") });
    expect(await w.names({})).toEqual(["alpha", "Bravo", "Charlie"]);
    expect(await w.names({ sort: "year" })).toEqual(["alpha", "Charlie", "Bravo"]);
    expect(await w.names({ sort: "added" })).toEqual(["Charlie", "Bravo", "alpha"]);
  });
});

describe("genre", () => {
  it("narrows to one, and the genres are listed with counts", async () => {
    const w = await world();
    await w.film("A", { genres: ["Drama", "Comedy"] });
    await w.film("B", { genres: ["Drama"] });
    await w.film("C", { genres: ["Horror"] });
    await w.film("D", { genres: [] });
    expect(await w.names({ genre: "Drama" })).toEqual(["A", "B"]);
    expect(await w.names({ genre: "Nothing" })).toEqual([]);
    expect(await libraryGenres(db, w.scope(), w.movies.id, DEFAULT_OPTIONS)).toEqual([{ name: "Comedy", count: 1 }, { name: "Drama", count: 2 }, { name: "Horror", count: 1 }]);
    // The list shows what is left under the other filters, but doesn't narrow itself to the chosen genre.
    expect((await libraryGenres(db, w.scope(), w.movies.id, opts({ genre: "Horror" }))).map((g) => g.name)).toEqual(["Comedy", "Drama", "Horror"]);
  });
  it("is matched exactly, not by a part of a name or with wildcards", async () => {
    const w = await world();
    await w.film("A", { genres: ["Science Fiction"] });
    expect(await w.names({ genre: "Science" })).toEqual([]);
    expect(await w.names({ genre: "%" })).toEqual([]);
    expect(await w.names({ genre: "Science Fiction" })).toEqual(["A"]);
  });
});

describe("unwatched only", () => {
  it("leaves out finished movies, and shows whose every playable episode is finished", async () => {
    const w = await world();
    const seen = await w.film("Seen");
    await w.film("Fresh");
    const partway = await w.film("Partway");
    await db.insert(watchState).values([
      { viewerId: w.member.viewer.id, ownerKind: "title", ownerId: seen.id, positionSeconds: 100, durationSeconds: 100, finished: true },
      { viewerId: w.member.viewer.id, ownerKind: "title", ownerId: partway.id, positionSeconds: 50, durationSeconds: 100, finished: false },
    ]);
    expect(await w.names({ unwatched: true })).toEqual(["Fresh", "Partway"]);

    const done = await makeShow(db, w.shows.id, 2, { name: "Done Show" });
    const going = await makeShow(db, w.shows.id, 2, { name: "Going Show" });
    const noFiles = await makeShow(db, w.shows.id, 1, { name: "No Files Show" });
    for (const [show, finishedCount] of [[done, 2], [going, 1]] as const) {
      for (const [i, ep] of show.episodes.entries()) {
        await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: ep.id, partIndex: 0, boxFileId: `uw${ep.id}`, filename: "e.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 100 });
        if (i < finishedCount) await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: ep.id, positionSeconds: 100, durationSeconds: 100, finished: true });
      }
    }
    expect(noFiles.show.id).toBeTruthy();
    expect(await w.names({ unwatched: true }, w.shows.id)).toEqual(["Going Show"]);
    expect(await w.names({}, w.shows.id)).toEqual(["Done Show", "Going Show", "No Files Show"]);
  });
  it("is about this profile only", async () => {
    const w = await world();
    const other = await makeAccount(db, "other");
    const f = await w.film("Film");
    await db.insert(watchState).values({ viewerId: other.viewer.id, ownerKind: "title", ownerId: f.id, positionSeconds: 100, durationSeconds: 100, finished: true });
    expect(await w.names({ unwatched: true })).toEqual(["Film"]);
  });
});

describe("owner", () => {
  it("narrows to a household's, or to what nobody owns, but only on a server that tracks ownership", async () => {
    const w = await world();
    const a = await w.film("Mine");
    await w.film("Nobody's");
    await assignOwners(db, { serverId: w.server.id, units: [{ titleId: a.id, seasonId: null }], accountId: w.member.accountId, via: "assigned" });
    // Not tracked: the owner option is ignored.
    expect(await w.names({ owner: "none" })).toEqual(["Mine", "Nobody's"]);
    await saveSettings(db, w.server.id, { enabled: true });
    expect(await w.names({ owner: "none" })).toEqual(["Nobody's"]);
    expect(await w.names({ owner: w.member.accountId })).toEqual(["Mine"]);
    expect(await w.names({ owner: "123e4567-e89b-42d3-a456-426614174000" })).toEqual([]);
  });
  it("counts a show as owned when any season is", async () => {
    const w = await world();
    const s = await makeShow(db, w.shows.id, 1, { name: "Show" });
    await makeShow(db, w.shows.id, 1, { name: "Other Show" });
    await saveSettings(db, w.server.id, { enabled: true });
    await assignOwners(db, { serverId: w.server.id, units: [{ titleId: s.show.id, seasonId: s.season.id }], accountId: w.member.accountId, via: "assigned" });
    expect(await w.names({ owner: w.member.accountId }, w.shows.id)).toEqual(["Show"]);
    expect(await w.names({ owner: "none" }, w.shows.id)).toEqual(["Other Show"]);
  });
});

describe("combined, and the limits still apply", () => {
  it("puts the options together", async () => {
    const w = await world();
    await w.film("A", { genres: ["Drama"], year: 2000 });
    await w.film("B", { genres: ["Drama"], year: 2010 });
    const c = await w.film("C", { genres: ["Drama"], year: 2005 });
    await w.film("D", { genres: ["Comedy"], year: 2020 });
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: c.id, positionSeconds: 1, durationSeconds: 1, finished: true });
    expect(await w.names({ genre: "Drama", unwatched: true, sort: "year" })).toEqual(["B", "A"]);
  });
  it("never shows what the age limit hides, whatever is asked for", async () => {
    const w = await world();
    await w.film("Kids", { genres: ["Family"], ratingAges: { ANY: 0 } });
    await w.film("Grown-up", { genres: ["Family"], ratingAges: { ANY: 17 } });
    expect(await w.names({ genre: "Family" }, w.movies.id, 1, kid)).toEqual(["Kids"]);
    expect((await libraryGenres(db, w.scope(kid), w.movies.id, DEFAULT_OPTIONS))).toEqual([{ name: "Family", count: 1 }]);
  });
  it("does not open a library of another kind or another server", async () => {
    const [a, b] = [await world(), await world()];
    expect(await libraryTitles(db, a.scope(), b.movies.id, 1, DEFAULT_OPTIONS)).toBeNull();
  });
});

describe("jumping to a letter", () => {
  it("lands on the page holding the first title at or after it", async () => {
    const w = await world();
    const letters = "ABCDEFGHIJ";
    // 60 titles: six for each of ten letters, so a letter's page is easy to predict.
    for (const l of letters) for (let i = 0; i < 6; i++) await w.film(`${l}${i}`);
    expect(await pageForLetter(db, w.scope(), w.movies.id, "A", DEFAULT_OPTIONS)).toBe(1);
    expect(await pageForLetter(db, w.scope(), w.movies.id, "#", DEFAULT_OPTIONS)).toBe(1);
    expect(await pageForLetter(db, w.scope(), w.movies.id, "E", DEFAULT_OPTIONS)).toBe(Math.floor(24 / PAGE_SIZE) + 1); // 24 titles come before "E": the second page starts there
    expect(await pageForLetter(db, w.scope(), w.movies.id, "J", DEFAULT_OPTIONS)).toBe(Math.floor(54 / PAGE_SIZE) + 1);
    expect(await pageForLetter(db, w.scope(), w.movies.id, "Z", DEFAULT_OPTIONS)).toBe(Math.floor(60 / PAGE_SIZE) + 1);
    // With a filter on, the letter is found among what is left.
    await db.update(titles).set({ genres: ["X"] }).where(eq(titles.name, "J5"));
    expect(await pageForLetter(db, w.scope(), w.movies.id, "Z", opts({ genre: "X" }))).toBe(1);
  });
});


describe("collections as single tiles", () => {
  const series = (w: Awaited<ReturnType<typeof world>>, name: string, year: number, over: Partial<typeof titles.$inferInsert> = {}) =>
    w.film(name, { year, collectionTmdbId: 5, collectionName: "Alien Collection", ...over });
  const namesOf = async (w: Awaited<ReturnType<typeof world>>, group: boolean, o: Partial<LibraryOptions> = {}, page = 1, viewer = adult) => {
    const r = await libraryTitles(db, w.scope(viewer), w.movies.id, page, opts(o), group);
    return r!.items.map((i) => `${i.kind === "collection" ? "[]" : ""}${i.name}`);
  };

  it("puts the collection first and leaves its films out of the list, only when asked", async () => {
    const w = await world();
    await series(w, "Alien", 1979);
    await series(w, "Aliens", 1986);
    await w.film("Zodiac");
    await syncSeriesCollections(db, w.movies.id);
    expect(await namesOf(w, false)).toEqual(["Alien", "Aliens", "Zodiac"]);
    expect(await namesOf(w, true)).toEqual(["[]Alien Collection", "Zodiac"]);
  });

  it("shows every film again when the list is filtered, and shows the films of a series that has too few for this profile", async () => {
    const w = await world();
    await series(w, "Alien", 1979, { genres: ["Horror"] });
    await series(w, "Aliens", 1986, { genres: ["Horror"], ratingAges: { US: 17 } });
    await syncSeriesCollections(db, w.movies.id);
    expect(await namesOf(w, true, { genre: "Horror" })).toEqual(["Alien", "Aliens"]);
    const kidView: AccessProfile = { locale: "en-US", maxAge: 21, allowUnrated: true };
    expect(await namesOf(w, true, {}, 1, kidView)).toEqual(["[]Alien Collection"]);
    await db.update(titles).set({ ratingAges: { US: 18 } }).where(eq(titles.name, "Aliens"));
    const limited: AccessProfile = { locale: "en-US", maxAge: 12, allowUnrated: true };
    expect(await namesOf(w, true, {}, 1, limited)).toEqual(["Alien"]); // one film is all this profile can see: no tile, the film itself
  });

  it("puts the tiles on the first page only, with the rest paging as before", async () => {
    const w = await world();
    await series(w, "Alien", 1979);
    await series(w, "Aliens", 1986);
    for (let i = 0; i < PAGE_SIZE + 3; i++) await w.film(`Film ${String(i).padStart(2, "0")}`);
    await syncSeriesCollections(db, w.movies.id);
    const first = await namesOf(w, true);
    expect(first[0]).toBe("[]Alien Collection");
    expect(first).toHaveLength(PAGE_SIZE + 1);
    expect(await namesOf(w, true, {}, 2)).toEqual(["Film 24", "Film 25", "Film 26"]);
  });
});
