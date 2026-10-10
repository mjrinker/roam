/** Random things to choose between: only playable, allowed, not already shown, and a library is picked before an item. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { musicAlbums, musicArtists, mediaFiles, watchState } from "@/lib/db/schema";
import type { LibraryActor } from "@/lib/content/library-access";
import { choosableLibraries } from "./libraries";
import { pickRandomItems } from "./pick";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const actor: LibraryActor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const file = (ownerKind: "title" | "episode", ownerId: string, over: Partial<typeof mediaFiles.$inferInsert> = {}) =>
    db.insert(mediaFiles).values({ ownerKind, ownerId, partIndex: 0, boxFileId: `b${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 100, ...over });
  const pick = async (libs: Awaited<ReturnType<typeof choosableLibraries>>, count: number, exclude: string[] = [], viewer: typeof adult | typeof kid = adult, random?: () => number) =>
    pickRandomItems(db, { actor, viewer, viewerId: me.viewer.id, libraries: libs, exclude, count, random });
  return { server, me, actor, file, pick };
}

describe("which libraries can be chosen from", () => {
  it("leaves out photos, libraries this profile can't see, and ones not asked for", async () => {
    const w = await world();
    const movies = await makeLibrary(db, w.server.id, "movies", "everyone");
    await makeLibrary(db, w.server.id, "photos", "everyone");
    await makeLibrary(db, w.server.id, "movies", "restricted");
    const other = await makeLibrary(db, w.server.id, "audio", "everyone");
    expect((await choosableLibraries(db, w.actor)).map((l) => l.id).sort()).toEqual([movies.id, other.id].sort());
    expect((await choosableLibraries(db, w.actor, [movies.id])).map((l) => l.id)).toEqual([movies.id]);
  });
});

describe("picking random items", () => {
  it("offers two different playable movies, never one without a file, one hidden by the age limit, or an excluded one", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "movies", "everyone");
    const a = await makeTitle(db, lib.id, { kind: "movie", name: "A", ratingAges: { ANY: 0 }, runtimeSeconds: 100 });
    const b = await makeTitle(db, lib.id, { kind: "movie", name: "B", ratingAges: { ANY: 0 } });
    const c = await makeTitle(db, lib.id, { kind: "movie", name: "C", ratingAges: { ANY: 0 } });
    const noFile = await makeTitle(db, lib.id, { kind: "movie", name: "No file", ratingAges: { ANY: 0 } });
    const adultOnly = await makeTitle(db, lib.id, { kind: "movie", name: "Adult", ratingAges: { ANY: 17 } });
    for (const t of [a, b, c, adultOnly]) await w.file("title", t.id);
    void noFile;
    const libs = await choosableLibraries(db, w.actor);
    for (let i = 0; i < 12; i++) {
      const two = await w.pick(libs, 2, [], kid);
      expect(two).toHaveLength(2);
      expect(new Set(two.map((x) => x.id)).size).toBe(2);
      expect(two.every((x) => [a.id, b.id, c.id].includes(x.id))).toBe(true);
    }
    const rest = await w.pick(libs, 2, [a.id, b.id], kid);
    expect(rest.map((x) => x.id)).toEqual([c.id]); // only one is left, so only one comes back
    expect(await w.pick(libs, 1, [a.id, b.id, c.id], kid)).toEqual([]);
    expect((await w.pick(libs, 2, [], adult)).length).toBe(2);
    expect(rest[0]).toMatchObject({ noun: "movie", verb: "Watch", action: { kind: "go", href: `/s/${w.server.id}/watch/title/${c.id}` }, pageHref: `/s/${w.server.id}/title/${c.id}` });
  });

  it("picks the library first, so a small one isn't drowned by a big one", async () => {
    const w = await world();
    const big = await makeLibrary(db, w.server.id, "movies", "everyone");
    const small = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    for (let i = 0; i < 30; i++) await w.file("title", (await makeTitle(db, big.id, { kind: "movie", name: `M${i}`, ratingAges: { ANY: 0 } })).id);
    const book = await makeTitle(db, small.id, { kind: "audiobook", name: "The Only Book", authors: ["Someone"], ratingAges: { ANY: 0 } });
    await w.file("title", book.id);
    const libs = await choosableLibraries(db, w.actor);
    // The libraries come A to Z by name; random() = 0.9 picks the last of two, 0.1 the first.
    const names = libs.map((l) => l.id);
    const lastFirst = await w.pick(libs, 1, [], adult, () => 0.9);
    expect(lastFirst[0].libraryId).toBe(names[1]);
    const firstFirst = await w.pick(libs, 1, [], adult, () => 0.1);
    expect(firstFirst[0].libraryId).toBe(names[0]);
    const withBook = [libs.find((l) => l.id === small.id)!];
    expect((await w.pick(withBook, 1))[0]).toMatchObject({ noun: "audiobook", verb: "Listen to", subtitle: "Someone", action: { kind: "listen", titleId: book.id } });
  });

  it("skips a library that has run out and carries on with the others", async () => {
    const w = await world();
    const empty = await makeLibrary(db, w.server.id, "movies", "everyone");
    const full = await makeLibrary(db, w.server.id, "video", "everyone");
    void empty;
    const v1 = await makeTitle(db, full.id, { kind: "movie", name: "V1", ratingAges: { ANY: 0 } });
    const v2 = await makeTitle(db, full.id, { kind: "movie", name: "V2", ratingAges: { ANY: 0 } });
    await w.file("title", v1.id);
    await w.file("title", v2.id);
    const libs = await choosableLibraries(db, w.actor);
    const two = await w.pick(libs, 2);
    expect(two.map((x) => x.id).sort()).toEqual([v1.id, v2.id].sort());
    expect(two[0].noun).toBe("video");
  });

  it("starts a show on the first episode this profile hasn't finished", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "shows", "everyone");
    const { show, episodes } = await makeShow(db, lib.id, 3, { name: "A Show", year: 2010 });
    for (const e of episodes) await w.file("episode", e.id);
    await db.insert(watchState).values({ viewerId: w.me.viewer.id, ownerKind: "episode", ownerId: episodes[0].id, positionSeconds: 0, durationSeconds: 100, finished: true });
    const libs = await choosableLibraries(db, w.actor);
    const [item] = await w.pick(libs, 1);
    expect(item).toMatchObject({ id: show.id, noun: "show", verb: "Watch", subtitle: "2010", action: { kind: "go", href: `/s/${w.server.id}/watch/episode/${episodes[1].id}` } });
    await db.insert(watchState).values([1, 2].map((i) => ({ viewerId: w.me.viewer.id, ownerKind: "episode" as const, ownerId: episodes[i].id, positionSeconds: 0, durationSeconds: 100, finished: true })));
    expect((await w.pick(libs, 1))[0].action).toEqual({ kind: "go", href: `/s/${w.server.id}/watch/episode/${episodes[0].id}` }); // all finished: from the start
  });

  it("offers an album from a music library, and a book to read from an eBook library", async () => {
    const w = await world();
    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    const [artist] = await db.insert(musicArtists).values({ libraryId: music.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
    const [album] = await db.insert(musicAlbums).values({ libraryId: music.id, artistId: artist.id, name: "Record", nameKey: "record", year: 1999 }).returning();
    const songs = [];
    for (let i = 0; i < 2; i++) songs.push((await makeTitle(db, music.id, { kind: "audiobook", name: `S${i}`, albumId: album.id, trackNumber: i + 1, sortKey: String(i), ratingAges: { ANY: 0 } })).id);
    const books = await makeLibrary(db, w.server.id, "ebooks", "everyone");
    const ebook = await makeTitle(db, books.id, { kind: "ebook", name: "A Read", authors: ["Writer"], ratingAges: { ANY: 0 } });
    await w.file("title", ebook.id, { durationSeconds: null, container: "epub" });
    const libs = await choosableLibraries(db, w.actor);
    const items = await w.pick(libs, 2);
    const byNoun = Object.fromEntries(items.map((i) => [i.noun, i]));
    expect(byNoun.album).toMatchObject({ id: album.id, verb: "Listen to", subtitle: "Band · 1999", action: { kind: "listen-list", songIds: songs } });
    expect(byNoun.book).toMatchObject({ id: ebook.id, verb: "Read", subtitle: "Writer", action: { kind: "go", href: `/s/${w.server.id}/read/${ebook.id}` } });
  });
});
