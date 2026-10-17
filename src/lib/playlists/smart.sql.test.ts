/** Smart playlists: what the rules select for the owner, and that the playlist keeps up with them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mediaFiles, musicAlbums, musicArtists, playlistItems, playlists, ratings, titleCast, titleCrew, titles, viewers, watchState } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { loadContext } from "./context";
import { listVisibleItems } from "./items";
import { addItem as addItemService } from "./item-service";
import { createPlaylist, getPlaylistDetail, patchPlaylist } from "./service";
import { createLabel, setTitleLabel } from "@/lib/labels/service";
import { evaluateRules, refreshSmartPlaylist, refreshSmartIfStale, smartRulesSchema, SMART_STALE_MS, type SmartRules } from "./smart";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "./test-db";

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
let n = 0;
/** Rules for movies unless told otherwise. (`media` and `libraryId` are how rules were saved before libraries were chosen by name; they are still read.) */
const rules = (over: Record<string, unknown> = {}): SmartRules => smartRulesSchema.parse({ media: "movies", ...over });
/** Rules in the current shape: libraries chosen by id. */
const chosen = (over: Record<string, unknown> = {}): SmartRules => smartRulesSchema.parse(over);

async function world() {
  const admin = await makeAccount(db, `sadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `sme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const viewerId = me.viewer.id;
  const movie = async (name: string, o: Partial<typeof titles.$inferInsert> & { playable?: boolean } = {}) => {
    const { playable, ...rest } = o;
    const t = await makeTitle(db, lib.id, { kind: "movie", name, year: 2000, ...rest });
    if (playable !== false) await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `sm${++n}`, filename: "m.mp4" });
    return t;
  };
  const rate = (titleId: string, halfStars: number) => db.insert(ratings).values({ viewerId, ownerKind: "title", ownerId: titleId, halfStars });
  const run = async (r: SmartRules, viewer = adult) => (await evaluateRules(db, { rules: r, actor, viewer, viewerId })).map((t) => ("titleId" in t ? t.titleId : t.episodeId));
  const names = async (r: SmartRules, viewer = adult) => {
    const ids = await run(r, viewer);
    const rows = await db.select({ id: titles.id, name: titles.name }).from(titles);
    return ids.map((id) => rows.find((x) => x.id === id)?.name);
  };
  return { admin, server, me, lib, actor, viewerId, movie, rate, run, names };
}

describe("what the rules select", () => {
  it("is the playable movies, by title, unless told otherwise", async () => {
    const w = await world();
    await w.movie("Bravo");
    await w.movie("alpha");
    await w.movie("No file", { playable: false });
    expect(await w.names(rules())).toEqual(["alpha", "Bravo"]);
  });

  it("narrows to what is under any of the owner's own labels, and never uses somebody else's", async () => {
    const w = await world();
    const a = await w.movie("Alpha");
    const b = await w.movie("Bravo");
    await w.movie("Charlie");
    const date = await createLabel(db, w.viewerId, "Date night");
    const xmas = await createLabel(db, w.viewerId, "Christmas");
    if (!date.ok || !xmas.ok) throw new Error("x");
    await setTitleLabel(db, w.viewerId, date.value.id, a.id, true);
    await setTitleLabel(db, w.viewerId, xmas.value.id, b.id, true);
    expect(await w.names(rules({ labelIds: [date.value.id] }))).toEqual(["Alpha"]);
    expect(await w.names(rules({ labelIds: [date.value.id, xmas.value.id] }))).toEqual(["Alpha", "Bravo"]);
    expect(await w.names(rules({ labelIds: ["123e4567-e89b-42d3-a456-426614174000"] }))).toEqual([]);
    // someone else's label, even with its id in the rules, selects nothing for this owner
    const other = await makeAccount(db, `lbother${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    const theirs = await createLabel(db, other.viewer.id, "Theirs");
    if (!theirs.ok) throw new Error("x");
    await setTitleLabel(db, other.viewer.id, theirs.value.id, a.id, true);
    expect(await w.names(rules({ labelIds: [theirs.value.id] }))).toEqual([]);
    expect(smartRulesSchema.safeParse({ labelIds: ["not-an-id"] }).success).toBe(false);
    expect(smartRulesSchema.safeParse({ labelIds: Array.from({ length: 11 }, () => "123e4567-e89b-42d3-a456-426614174000") }).success).toBe(false);
  });

  it("reaches a show's episodes through the show's label", async () => {
    const w = await world();
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const labelled = await makeShow(db, shows.id, 2, { name: "Labelled show" }, { files: true });
    await makeShow(db, shows.id, 2, { name: "Plain show" }, { files: true });
    const l = await createLabel(db, w.viewerId, "Binge");
    if (!l.ok) throw new Error("x");
    await setTitleLabel(db, w.viewerId, l.value.id, labelled.show.id, true);
    expect(await w.names(chosen({ libraryIds: [shows.id], labelIds: [l.value.id] }))).toEqual(["Labelled show"]);
    const eps = await w.run(chosen({ libraryIds: [shows.id], showsAs: "episodes", labelIds: [l.value.id] }));
    expect(eps.sort()).toEqual(labelled.episodes.map((e) => e.id).sort());
  });

  it("narrows by genre (any of), year, how recently it was added, and library", async () => {
    const w = await world();
    await w.movie("Old drama", { genres: ["Drama"], year: 1985 });
    await w.movie("New drama", { genres: ["Drama"], year: 2020 });
    await w.movie("New comedy", { genres: ["Comedy"], year: 2021 });
    await w.movie("Old news", { genres: ["Drama"], year: 2021, addedAt: new Date("2020-01-01") });
    expect(await w.names(rules({ genres: ["Drama"], sort: "oldest" }))).toEqual(["Old drama", "New drama", "Old news"]);
    expect(await w.names(rules({ genres: ["Drama", "Comedy"], yearFrom: 2020, yearTo: 2020 }))).toEqual(["New drama"]);
    expect(await w.names(rules({ yearFrom: 2020, addedWithinDays: 30 }))).toEqual(["New comedy", "New drama"]);
    const other = await makeLibrary(db, w.server.id, "movies", "everyone");
    const elsewhere = await makeTitle(db, other.id, { kind: "movie", name: "Elsewhere" });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: elsewhere.id, boxFileId: `sm${++n}`, filename: "m.mp4" });
    expect(await w.names(rules({ libraryId: other.id }))).toEqual(["Elsewhere"]); // the old way of naming a library
  });

  it("uses the owner's own ratings: at least, at most, rated and not rated, and sorts by them", async () => {
    const w = await world();
    const [a, b, c] = [await w.movie("Loved"), await w.movie("Liked"), await w.movie("Meh")];
    await w.movie("Unrated");
    await w.rate(a.id, 10);
    await w.rate(b.id, 8);
    await w.rate(c.id, 4);
    expect(await w.names(rules({ minStars: 8 }))).toEqual(["Liked", "Loved"]);
    expect(await w.names(rules({ minStars: 8, sort: "rating" }))).toEqual(["Loved", "Liked"]);
    expect(await w.names(rules({ maxStars: 4 }))).toEqual(["Meh"]);
    expect(await w.names(rules({ rated: "unrated" }))).toEqual(["Unrated"]);
    expect(await w.names(rules({ rated: "rated", sort: "rating" }))).toEqual(["Loved", "Liked", "Meh"]);
    const other = await makeAccount(db, `sother${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    await db.insert(ratings).values({ viewerId: other.viewer.id, ownerKind: "title", ownerId: b.id, halfStars: 1 });
    expect(await w.names(rules({ maxStars: 2 }))).toEqual([]); // somebody else's rating doesn't count
  });

  it("uses the owner's watching: unwatched, in progress, watched", async () => {
    const w = await world();
    const [seen, half, fresh] = [await w.movie("Seen"), await w.movie("Half"), await w.movie("Fresh")];
    await db.insert(watchState).values([
      { viewerId: w.viewerId, ownerKind: "title", ownerId: seen.id, positionSeconds: 100, durationSeconds: 100, finished: true },
      { viewerId: w.viewerId, ownerKind: "title", ownerId: half.id, positionSeconds: 40, durationSeconds: 100, finished: false },
    ]);
    expect(await w.names(rules({ watched: "unwatched" }))).toEqual(["Fresh"]);
    expect(await w.names(rules({ watched: "inProgress" }))).toEqual(["Half"]);
    expect(await w.names(rules({ watched: "watched" }))).toEqual(["Seen"]);
    void fresh;
  });

  it("narrows by how long it runs, using its stated runtime or else its files, and ignores it for shows", async () => {
    const w = await world();
    await w.movie("Short", { runtimeSeconds: 40 * 60 });
    await w.movie("Feature", { runtimeSeconds: 100 * 60 });
    await w.movie("Epic", { runtimeSeconds: 170 * 60 });
    const unknown = await w.movie("From files");
    await db.update(mediaFiles).set({ durationSeconds: 95 * 60 }).where(eq(mediaFiles.ownerId, unknown.id));
    expect(await w.names(rules({ minMinutes: 90, maxMinutes: 120 }))).toEqual(["Feature", "From files"]);
    expect(await w.names(rules({ maxMinutes: 60 }))).toEqual(["Short"]);
    expect(await w.names(rules({ minMinutes: 150 }))).toEqual(["Epic"]);
    // a copy saved in two resolutions is one length, not two
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: unknown.id, boxFileId: `sm${++n}`, filename: "m720.mp4", versionLabel: "720p", durationSeconds: 95 * 60 });
    await db.update(mediaFiles).set({ versionLabel: "1080p" }).where(and(eq(mediaFiles.filename, "m.mp4"), eq(mediaFiles.ownerId, unknown.id)));
    expect(await w.names(rules({ minMinutes: 90, maxMinutes: 120 }))).toContain("From files");
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const s = await makeShow(db, shows.id, 1, { name: "A Show" });
    await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: s.episodes[0].id, boxFileId: `sm${++n}`, filename: "e.mp4", durationSeconds: 30 * 60 });
    expect(await w.names(rules({ media: "shows", minMinutes: 500 }))).toEqual(["A Show"]);
    expect(await w.run(rules({ media: "episodes", minMinutes: 20, maxMinutes: 40 }))).toEqual([s.episodes[0].id]);
    expect(await w.run(rules({ media: "episodes", minMinutes: 60 }))).toEqual([]);
  });

  it("keeps to what the owner may see: the age limit and library sharing, and caps the length", async () => {
    const w = await world();
    await w.movie("Kids", { ratingAges: { US: 0 } });
    await w.movie("Grown-up", { ratingAges: { US: 17 } });
    expect(await w.names(rules(), kid)).toEqual(["Kids"]);
    const restricted = await makeLibrary(db, w.server.id, "movies", "restricted");
    const hidden = await makeTitle(db, restricted.id, { kind: "movie", name: "Hidden" });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: hidden.id, boxFileId: `sm${++n}`, filename: "m.mp4" });
    expect(await w.names(rules())).not.toContain("Hidden");
    for (let i = 0; i < 5; i++) await w.movie(`Extra ${i}`);
    expect(await w.run(rules({ limit: 3 }))).toHaveLength(3);
  });

  it("selects shows (by how much of them is watched), episodes, songs and audiobooks", async () => {
    const w = await world();
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const s1 = await makeShow(db, shows.id, 2, { name: "Fresh Show", genres: ["Drama"] });
    const s2 = await makeShow(db, shows.id, 2, { name: "Done Show", genres: ["Comedy"] });
    for (const e of [...s1.episodes, ...s2.episodes]) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: e.id, boxFileId: `sm${++n}`, filename: "e.mp4" });
    for (const e of s2.episodes) await db.insert(watchState).values({ viewerId: w.viewerId, ownerKind: "episode", ownerId: e.id, positionSeconds: 1, durationSeconds: 1, finished: true });
    expect(await w.names(rules({ media: "shows", watched: "unwatched" }))).toEqual(["Fresh Show"]);
    expect(await w.names(rules({ media: "shows", watched: "watched" }))).toEqual(["Done Show"]);
    await db.insert(watchState).values({ viewerId: w.viewerId, ownerKind: "episode", ownerId: s1.episodes[0].id, positionSeconds: 1, durationSeconds: 1, finished: true });
    expect(await w.names(rules({ media: "shows", watched: "inProgress" }))).toEqual(["Fresh Show"]);
    const eps = await w.run(rules({ media: "episodes", genres: ["Drama"], watched: "unwatched" }));
    expect(eps).toEqual([s1.episodes[1].id]); // in order, and only unwatched episodes of drama shows

    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    const song = await makeTitle(db, music.id, { kind: "audiobook", name: "A Song" });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: song.id, boxFileId: `sm${++n}`, filename: "s.mp3" });
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "A Book" });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: book.id, boxFileId: `sm${++n}`, filename: "b.m4b" });
    expect(await w.names(rules({ media: "songs" }))).toEqual(["A Song"]);
    expect(await w.names(rules({ media: "audiobooks" }))).toEqual(["A Book"]);
  });

  it("orders by duration, rating, when it was added, when it was last watched, genre or name, with what has none always last", async () => {
    const w = await world();
    const a = await w.movie("Alpha", { runtimeSeconds: 100 * 60, genres: ["Western", "Drama"], addedAt: new Date("2024-03-01") });
    const b = await w.movie("Bravo", { runtimeSeconds: 80 * 60, genres: ["Action"], addedAt: new Date("2025-03-01") });
    const c = await w.movie("Charlie", { runtimeSeconds: 120 * 60, genres: [], addedAt: new Date("2023-03-01") });
    await w.movie("Delta", { genres: ["Comedy"], addedAt: new Date("2022-03-01") }); // no runtime anywhere
    await w.rate(a.id, 6);
    await w.rate(b.id, 9);
    await db.insert(watchState).values([
      { viewerId: w.viewerId, ownerKind: "title", ownerId: a.id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: new Date("2026-01-01") },
      { viewerId: w.viewerId, ownerKind: "title", ownerId: c.id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: new Date("2026-06-01") },
    ]);
    const order = async (sort: string) => w.names(rules({ sort }));
    expect(await order("longest")).toEqual(["Charlie", "Alpha", "Bravo", "Delta"]);
    expect(await order("shortest")).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);
    expect(await order("rating")).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);
    expect(await order("ratingLowest")).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(await order("added")).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);
    expect(await order("addedOldest")).toEqual(["Delta", "Charlie", "Alpha", "Bravo"]);
    expect(await order("watchedRecently")).toEqual(["Charlie", "Alpha", "Bravo", "Delta"]);
    expect(await order("watchedLongAgo")).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);
    expect(await order("genre")).toEqual(["Bravo", "Delta", "Alpha", "Charlie"]); // Action, Comedy, Drama, then none
    expect(await order("titleDesc")).toEqual(["Delta", "Charlie", "Bravo", "Alpha"]);
    expect(await order("title")).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("orders by several things at once: each only breaks ties in the one before, and a random one ends the list", async () => {
    const w = await world();
    await w.movie("Old long", { year: 1990, runtimeSeconds: 150 * 60 });
    await w.movie("Old short", { year: 1990, runtimeSeconds: 80 * 60 });
    await w.movie("New short", { year: 2020, runtimeSeconds: 90 * 60 });
    await w.movie("New long", { year: 2020, runtimeSeconds: 130 * 60 });
    expect(await w.names(rules({ sorts: ["newest", "longest"] }))).toEqual(["New long", "New short", "Old long", "Old short"]);
    expect(await w.names(rules({ sorts: ["longest", "newest"] }))).toEqual(["Old long", "New long", "New short", "Old short"]);
    expect(await w.names(rules({ sorts: ["oldest", "shortest"] }))).toEqual(["Old short", "Old long", "New short", "New long"]);
    expect(await w.names(rules({ sorts: ["newest"] }))).toEqual(await w.names(rules({ sort: "newest" }))); // the same as one order
    // a random one last: the earlier orders still group the result, and only ties among them are shuffled
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const names = await w.names(rules({ sorts: ["newest", "random"] }));
      expect(new Set(names.slice(0, 2))).toEqual(new Set(["New long", "New short"]));
      seen.add(names.join());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("orders across kinds the same way, and a show is last watched when any of its episodes was", async () => {
    const w = await world();
    const long = await w.movie("Long film", { runtimeSeconds: 150 * 60 });
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const show = await makeShow(db, shows.id, 2, { name: "A show" });
    for (const e of show.episodes) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: e.id, boxFileId: `sm${++n}`, filename: "e.mp4", durationSeconds: 45 * 60 });
    await db.insert(watchState).values([
      { viewerId: w.viewerId, ownerKind: "episode", ownerId: show.episodes[1].id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: new Date("2026-05-01") },
      { viewerId: w.viewerId, ownerKind: "title", ownerId: long.id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: new Date("2026-02-01") },
    ]);
    expect(await w.names(chosen({ sort: "watchedRecently" }))).toEqual(["A show", "Long film"]);
    expect(await w.names(chosen({ sort: "watchedLongAgo" }))).toEqual(["Long film", "A show"]);
    const eps = await w.run(chosen({ libraryIds: [shows.id], showsAs: "episodes", sort: "longest" }));
    expect(eps).toEqual(show.episodes.map((e) => e.id)); // equal lengths stay in their order
    const both = await w.run(chosen({ libraryIds: [shows.id, (await db.select().from(titles).where(eq(titles.id, long.id)))[0].libraryId], showsAs: "episodes", sort: "longest" }));
    expect(both[0]).toBe(long.id);
  });

  it("narrows by name, by a person (cast, director, artist, author), by content rating, by scores and by what everyone gave it", async () => {
    const w = await world();
    const alien = await w.movie("Alien", { imdbRating: 8.5, rottenTomatoesScore: 93, ratingAges: { US: 17 } });
    const babe = await w.movie("Babe", { imdbRating: 6.8, rottenTomatoesScore: 97, ratingAges: { US: 0 } });
    await w.movie("Cube", { imdbRating: 7.2, rottenTomatoesScore: 60 }); // no content rating
    await db.insert(titleCast).values({ titleId: alien.id, personId: 1, name: "Sigourney Weaver", position: 0 });
    await db.insert(titleCrew).values({ titleId: babe.id, personId: 2, name: "Chris Noonan", job: "Director", position: 0 });
    expect(await w.names(rules({ titleContains: "LIE" }))).toEqual(["Alien"]); // any case, any part
    expect(await w.names(rules({ person: "weaver" }))).toEqual(["Alien"]);
    expect(await w.names(rules({ person: "noonan" }))).toEqual(["Babe"]);
    expect(await w.names(rules({ person: "nobody here" }))).toEqual([]);
    expect(await w.names(rules({ maxAge: 0 }))).toEqual(["Babe"]); // unrated Cube is left out
    expect(await w.names(rules({ maxAge: 13 }))).toEqual(["Babe"]);
    expect(await w.names(rules({ maxAge: 17 }))).toEqual(["Alien", "Babe"]);
    expect(await w.names(rules({ minImdb: 7 }))).toEqual(["Alien", "Cube"]);
    expect(await w.names(rules({ minRottenTomatoes: 90 }))).toEqual(["Alien", "Babe"]);
    expect(await w.names(rules({ minImdb: 7, minRottenTomatoes: 90 }))).toEqual(["Alien"]);
    const others = [await makeAccount(db, `savg${++n}`), await makeAccount(db, `savg${++n}`)];
    for (const o of others) await joinServer(db, w.server.id, o.accountId);
    await db.insert(ratings).values([
      { viewerId: others[0].viewer.id, ownerKind: "title", ownerId: babe.id, halfStars: 10 },
      { viewerId: others[1].viewer.id, ownerKind: "title", ownerId: babe.id, halfStars: 8 },
      { viewerId: others[0].viewer.id, ownerKind: "title", ownerId: alien.id, halfStars: 4 },
    ]);
    expect(await w.names(rules({ minAverage: 9 }))).toEqual(["Babe"]);
    expect(await w.names(rules({ minAverage: 4 }))).toEqual(["Alien", "Babe"]);
    // a song's artist and an audiobook's author
    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    const [artist] = await db.insert(musicArtists).values({ libraryId: music.id, name: "The Beatles", nameKey: `beatles${n}`, sortKey: "beatles" }).returning();
    const [album] = await db.insert(musicAlbums).values({ libraryId: music.id, artistId: artist.id, name: "Abbey Road", nameKey: `abbey${n}` }).returning();
    const song = await makeTitle(db, music.id, { kind: "audiobook", name: "Come Together", albumId: album.id });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: song.id, boxFileId: `sm${++n}`, filename: "s.mp3" });
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "Dune", authors: ["Frank Herbert"], narrators: ["Scott Brick"] });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: book.id, boxFileId: `sm${++n}`, filename: "d.m4b" });
    expect(await w.names(chosen({ person: "beatles" }))).toEqual(["Come Together"]);
    expect(await w.names(chosen({ person: "herbert" }))).toEqual(["Dune"]);
    expect(await w.names(chosen({ person: "brick" }))).toEqual(["Dune"]);
  });

  it("narrows by picture quality and by when the owner last watched it", async () => {
    const w = await world();
    const hd = await w.movie("In HD");
    const uhd = await w.movie("In 4K");
    const sd = await w.movie("In SD");
    await db.update(mediaFiles).set({ height: 1080 }).where(eq(mediaFiles.ownerId, hd.id));
    await db.update(mediaFiles).set({ height: 2160 }).where(eq(mediaFiles.ownerId, uhd.id));
    await db.update(mediaFiles).set({ height: 480 }).where(eq(mediaFiles.ownerId, sd.id));
    expect(await w.names(rules({ minHeight: 1080 }))).toEqual(["In 4K", "In HD"]);
    expect(await w.names(rules({ minHeight: 2160 }))).toEqual(["In 4K"]);
    const now = new Date("2026-06-15T12:00:00Z");
    const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await db.insert(watchState).values([
      { viewerId: w.viewerId, ownerKind: "title", ownerId: hd.id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: day(3) },
      { viewerId: w.viewerId, ownerKind: "title", ownerId: sd.id, positionSeconds: 1, durationSeconds: 10, finished: false, updatedAt: day(90) },
    ]);
    const on = async (r: Record<string, unknown>) => (await evaluateRules(db, { rules: smartRulesSchema.parse({ media: "movies", ...r }), actor: w.actor, viewer: adult, viewerId: w.viewerId, now })).map((t) => ("titleId" in t ? t.titleId : t.episodeId));
    expect(await on({ watchedWithinDays: 7 })).toEqual([hd.id]);
    expect(new Set(await on({ notWatchedWithinDays: 7 }))).toEqual(new Set([uhd.id, sd.id])); // never watched counts as not
    expect(await on({ watchedWithinDays: 120, notWatchedWithinDays: 7 })).toEqual([sd.id]);
  });

  it("orders by IMDb, Rotten Tomatoes, everyone's rating, content rating and picture quality, with what is missing last", async () => {
    const w = await world();
    const a = await w.movie("Alpha", { imdbRating: 6, rottenTomatoesScore: 90, ratingAges: { US: 17 } });
    const b = await w.movie("Bravo", { imdbRating: 9, rottenTomatoesScore: 50, ratingAges: { US: 0 } });
    const c = await w.movie("Charlie", { imdbRating: 7.5, rottenTomatoesScore: null, ratingAges: { US: 13 } });
    await w.movie("Delta");
    await db.update(mediaFiles).set({ height: 720 }).where(eq(mediaFiles.ownerId, a.id));
    await db.update(mediaFiles).set({ height: 2160 }).where(eq(mediaFiles.ownerId, b.id));
    const other = await makeAccount(db, `sord${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    await db.insert(ratings).values([
      { viewerId: other.viewer.id, ownerKind: "title", ownerId: a.id, halfStars: 10 },
      { viewerId: other.viewer.id, ownerKind: "title", ownerId: c.id, halfStars: 6 },
    ]);
    const order = (sort: string) => w.names(rules({ sort }));
    expect(await order("imdb")).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    expect(await order("rottenTomatoes")).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(await order("average")).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);
    expect(await order("contentRating")).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    expect(await order("quality")).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);
  });

  it("applies the same conditions to episodes through their show", async () => {
    const w = await world();
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const good = await makeShow(db, shows.id, 2, { name: "Good show", imdbRating: 8.8, ratingAges: { US: 13 } });
    const meh = await makeShow(db, shows.id, 1, { name: "Meh show", imdbRating: 5.1, ratingAges: { US: 13 } });
    for (const e of [...good.episodes, ...meh.episodes]) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: e.id, boxFileId: `sm${++n}`, filename: "e.mp4", height: 1080 });
    await db.insert(titleCast).values({ titleId: good.show.id, personId: 9, name: "Some Actor", position: 0 });
    const ids = (r: Record<string, unknown>) => w.run(chosen({ libraryIds: [shows.id], showsAs: "episodes", ...r }));
    expect(await ids({ minImdb: 8 })).toEqual(good.episodes.map((e) => e.id));
    expect(await ids({ person: "some actor" })).toEqual(good.episodes.map((e) => e.id));
    expect(await ids({ titleContains: "meh" })).toEqual(meh.episodes.map((e) => e.id));
    expect(await ids({ titleContains: "ep 2" })).toEqual([good.episodes[1].id]); // the episode's own name counts too
    expect(await ids({ maxAge: 10 })).toEqual([]);
    expect(await ids({ minHeight: 2160 })).toEqual([]);
    expect((await ids({ sort: "imdb" })).slice(0, 2)).toEqual(good.episodes.map((e) => e.id));
  });

  it("draws from the libraries chosen by name, across kinds, and from every library when none is chosen", async () => {
    const w = await world();
    const kids = await makeLibrary(db, w.server.id, "movies", "everyone");
    await w.movie("Grown-up film");
    const kidsFilm = await makeTitle(db, kids.id, { kind: "movie", name: "Kids film", year: 2010 });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: kidsFilm.id, boxFileId: `sm${++n}`, filename: "k.mp4" });
    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    const song = await makeTitle(db, music.id, { kind: "audiobook", name: "Kids song", year: 2012 });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: song.id, boxFileId: `sm${++n}`, filename: "s.mp3" });
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const show = await makeShow(db, shows.id, 2, { name: "Kids show", year: 2014 });
    for (const e of show.episodes) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: e.id, boxFileId: `sm${++n}`, filename: "e.mp4" });
    // one library
    expect(await w.names(chosen({ libraryIds: [kids.id] }))).toEqual(["Kids film"]);
    // several libraries of different kinds, mixed and put in order together
    expect(await w.names(chosen({ libraryIds: [kids.id, music.id, shows.id], sort: "newest" }))).toEqual(["Kids show", "Kids song", "Kids film"]);
    // a TV library can hold its episodes one by one
    expect(await w.run(chosen({ libraryIds: [shows.id], showsAs: "episodes" }))).toEqual(show.episodes.map((e) => e.id));
    // no library chosen: everything it can see, of every kind
    expect(await w.names(chosen({ sort: "newest", limit: 10 }))).toEqual(["Kids show", "Kids song", "Kids film", "Grown-up film"]);
    // the limit is for the whole playlist, not each kind
    expect(await w.run(chosen({ limit: 2, sort: "newest" }))).toHaveLength(2);
    // libraries the owner can't see give nothing
    const hidden = await makeLibrary(db, w.server.id, "movies", "restricted");
    expect(await w.run(chosen({ libraryIds: [hidden.id] }))).toEqual([]);
  });

  it("reads rules saved before libraries were chosen by name as the same thing", async () => {
    const parsed = smartRulesSchema.parse({ media: "episodes", libraryId: "123e4567-e89b-42d3-a456-426614174000", sort: "added" });
    expect(parsed).toMatchObject({ kinds: ["shows"], showsAs: "episodes", libraryIds: ["123e4567-e89b-42d3-a456-426614174000"], sorts: ["added"] });
    expect(smartRulesSchema.parse({ media: "songs" })).toMatchObject({ kinds: ["music", "audio"], libraryIds: [] });
    expect(smartRulesSchema.safeParse({ media: "nonsense" }).success).toBe(false);
    expect(smartRulesSchema.safeParse({ libraryIds: ["nope"] }).success).toBe(false);
    expect(smartRulesSchema.safeParse({ libraryIds: Array(31).fill("123e4567-e89b-42d3-a456-426614174000") }).success).toBe(false);
    expect(smartRulesSchema.parse({})).toMatchObject({ libraryIds: [], kinds: [], showsAs: "shows", sorts: ["title"], limit: 50 });
  });

  it("can pick at random, and refuses nonsense rules", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await w.movie(`M${i}`);
    expect(new Set(await w.run(rules({ sort: "random", limit: 4 }))).size).toBe(4);
    for (const bad of [{ media: "music" }, { media: "movies", limit: 0 }, { media: "movies", limit: 500 }, { media: "movies", minStars: 11 }, { media: "movies", sort: "nope" }, { media: "movies", extra: 1 }, { media: "movies", libraryId: "x" }, { media: "movies", genres: Array(11).fill("a") }]) {
      expect(smartRulesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(smartRulesSchema.parse({ media: "movies" })).toMatchObject({ sorts: ["title"], limit: 50, watched: "any", rated: "any" });
  });
});

describe("a smart playlist", () => {
  async function playlistWorld() {
    const w = await world();
    const make = async (r: SmartRules, name = "Smart") => {
      const made = await createPlaylist(db, { serverId: w.server.id, viewerId: w.viewerId, name, smartRules: r });
      if (!made.ok) throw new Error("not created");
      return made.value;
    };
    const items = async (id: string) => (await listVisibleItems(db, { playlistId: id, lib: w.actor, viewer: adult })).items;
    return { ...w, make, items };
  }

  it("starts with what its rules select, in order, and is not editable by hand", async () => {
    const w = await playlistWorld();
    await w.movie("B");
    const a = await w.movie("A");
    const smart = await w.make(rules());
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["A", "B"]);
    const ctx = await loadContext(db, { playlistId: smart.id, viewerId: w.viewerId });
    expect(ctx?.caps.canEditItems).toBe(false);
    const added = await addItemService(db, { playlistId: smart.id, viewerId: w.viewerId, titleId: a.id });
    expect(added.ok).toBe(false);
    const detail = await getPlaylistDetail(db, { playlistId: smart.id, viewerId: w.viewerId });
    expect(detail.ok && detail.value.smart).toBe(true);
    expect(detail.ok && detail.value.smartRules?.kinds).toEqual(["movies"]);
    expect(detail.ok && detail.value.can.editItems).toBe(false);
  });

  it("keeps up: a new match joins after a few minutes, keeping the ids of those that stay, and one that no longer matches leaves", async () => {
    const w = await playlistWorld();
    const a = await w.movie("A", { genres: ["Drama"] });
    const smart = await w.make(rules({ genres: ["Drama"] }));
    const before = await w.items(smart.id);
    await w.movie("C", { genres: ["Drama"] });
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["A"]); // not yet: it was refreshed a moment ago
    const later = new Date(Date.now() + SMART_STALE_MS + 1000);
    await refreshSmartIfStale(db, [smart.id], later);
    const after = await w.items(smart.id);
    expect(after.map((i) => i.name)).toEqual(["A", "C"]);
    expect(after[0].id).toBe(before[0].id); // the same row, so a queue pointing at it still works
    await db.update(titles).set({ genres: ["Comedy"] }).where(eq(titles.id, a.id));
    await refreshSmartPlaylist(db, smart.id, { force: true });
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["C"]);
  });

  it("shows the values of up to the first three orders on each item, in order, and leaves out those with nothing to show", async () => {
    const w = await playlistWorld();
    const a = await w.movie("Alpha", { runtimeSeconds: 100 * 60, year: 1999, imdbRating: 7.5 });
    await w.rate(a.id, 9);
    const labels = async (sorts: string[], viewerId = w.viewerId) => {
      const p = await w.make(rules({ sorts }), sorts.join());
      return (await listVisibleItems(db, { playlistId: p.id, lib: w.actor, viewer: adult, viewerId })).items.map((i) => [i.sortLabels, i.sortLabel]);
    };
    expect(await labels(["newest", "longest", "rating"])).toEqual([[["1999", "1h 40m", "★ 4.5"], "1999 · 1h 40m · ★ 4.5"]]);
    expect(await labels(["newest", "longest", "rating", "imdb"])).toEqual([[["1999", "1h 40m", "★ 4.5"], "1999 · 1h 40m · ★ 4.5"]]); // only the first three
    expect(await labels(["title", "imdb"])).toEqual([[["IMDb 7.5"], "IMDb 7.5"]]); // a name has no value to show
    expect(await labels(["title", "random"])).toEqual([[[], null]]);
    expect((await labels(["rating", "ratingLowest", "newest"]))[0][0]).toEqual(["★ 4.5", "1999"]); // said once
  });

  it("shows each item the value it is ordered by, and keeps the owner's private values to the owner", async () => {
    const w = await playlistWorld();
    const a = await w.movie("Alpha", { runtimeSeconds: 100 * 60, year: 1999 });
    await w.movie("Bravo", { runtimeSeconds: 45 * 60, year: 2005 });
    await w.rate(a.id, 9);
    const other = await makeAccount(db, `slab${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    const as = (sort: string) => w.make(rules({ sort }), sort);
    const labels = async (id: string, viewerId?: string) => (await listVisibleItems(db, { playlistId: id, lib: w.actor, viewer: adult, viewerId })).items.map((i) => [i.name, i.sortLabel]);
    const longest = await as("longest");
    expect(await labels(longest.id, w.viewerId)).toEqual([["Alpha", "1h 40m"], ["Bravo", "45m"]]);
    const oldest = await as("oldest");
    expect(await labels(oldest.id, other.viewer.id)).toEqual([["Alpha", "1999"], ["Bravo", "2005"]]);
    const best = await as("rating");
    expect(await labels(best.id, w.viewerId)).toEqual([["Alpha", "★ 4.5"], ["Bravo", null]]);
    expect(await labels(best.id, other.viewer.id)).toEqual([["Alpha", null], ["Bravo", null]]); // somebody else's ratings are not shown
    const byName = await as("title");
    expect((await labels(byName.id, w.viewerId)).every(([, label]) => label === null)).toBe(true);
    const plain = await createPlaylist(db, { serverId: w.server.id, viewerId: w.viewerId, name: "Plain" });
    if (!plain.ok) throw new Error("x");
    await db.insert(playlistItems).values({ playlistId: plain.value.id, titleId: a.id, position: 1024 });
    expect(await labels(plain.value.id, w.viewerId)).toEqual([["Alpha", null]]);
  });

  it("is refreshed for its owner, whoever opens it, and the opener still only sees what they may see", async () => {
    const w = await playlistWorld();
    await w.movie("Kids", { ratingAges: { US: 0 } });
    await w.movie("Grown-up", { ratingAges: { US: 17 } });
    const smart = await w.make(rules());
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["Grown-up", "Kids"]);
    const seenByKid = await listVisibleItems(db, { playlistId: smart.id, lib: w.actor, viewer: kid });
    expect(seenByKid.items.map((i) => i.name)).toEqual(["Kids"]);
  });

  it("changes when its rules change, and a random one only reshuffles when asked", async () => {
    const w = await playlistWorld();
    await w.movie("Drama", { genres: ["Drama"] });
    await w.movie("Comedy", { genres: ["Comedy"] });
    const smart = await w.make(rules({ genres: ["Drama"] }));
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["Drama"]);
    const patched = await patchPlaylist(db, { playlistId: smart.id, viewerId: w.viewerId, smartRules: rules({ genres: ["Comedy"] }) });
    expect(patched.ok).toBe(true);
    expect((await w.items(smart.id)).map((i) => i.name)).toEqual(["Comedy"]);

    const random = await w.make(rules({ sort: "random", limit: 2 }), "Random");
    const first = (await w.items(random.id)).map((i) => i.id);
    await refreshSmartIfStale(db, [random.id], new Date(Date.now() + 365 * 86_400_000));
    expect((await w.items(random.id)).map((i) => i.id)).toEqual(first);
  });

  it("can't be given rules if it is an ordinary playlist, and an ordinary one is never touched", async () => {
    const w = await playlistWorld();
    const plain = await createPlaylist(db, { serverId: w.server.id, viewerId: w.viewerId, name: "Plain" });
    if (!plain.ok) throw new Error("x");
    const t = await w.movie("X");
    expect((await patchPlaylist(db, { playlistId: plain.value.id, viewerId: w.viewerId, smartRules: rules() })).ok).toBe(false);
    expect(await refreshSmartPlaylist(db, plain.value.id, { force: true })).toBeNull();
    await db.insert(playlistItems).values({ playlistId: plain.value.id, titleId: t.id, position: 1024 });
    await refreshSmartIfStale(db, [plain.value.id], new Date(Date.now() + 10 * SMART_STALE_MS));
    expect((await w.items(plain.value.id)).map((i) => i.name)).toEqual(["X"]);
    void playlists; void viewers;
  });
});
