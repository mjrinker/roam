/** Reading a music library as artists, albums and songs, with the same access and age rules as everything else. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { libraryMembers, mediaFiles, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { getAlbum, getArtist, listAlbums, listArtists } from "./browse";

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

async function world(access: "everyone" | "restricted" = "everyone", ratingAges: Record<string, number> | null = null) {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const library = await makeLibrary(db, server.id, "music", access);
  const [artist] = await db.insert(musicArtists).values({ libraryId: library.id, name: "The Beatles", nameKey: "the beatles", sortKey: "beatles" }).returning();
  const album = async (name: string, year: number | null, tracks: { name: string; track: number | null; disc?: number | null; poster?: string; seconds?: number; authors?: string[] }[], artistId = artist.id) => {
    const [a] = await db.insert(musicAlbums).values({ libraryId: library.id, artistId, name, nameKey: name.toLowerCase(), year }).returning();
    for (const t of tracks) {
      const title = await makeTitle(db, library.id, {
        kind: "audiobook", name: t.name, boxFolderId: `file:${Math.random()}`, albumId: a.id, trackNumber: t.track, discNumber: t.disc ?? null, posterUrl: t.poster ?? null, ratingAges, authors: t.authors ?? null,
      });
      await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: title.id, partIndex: 0, boxFileId: `f${Math.random()}`, filename: `${t.name}.mp3`, durationSeconds: t.seconds ?? 100, probeStatus: "ok" });
    }
    return a;
  };
  const actor = (a: { accountId: string }, isAdmin = false): LibraryActor => ({ serverId: server.id, accountId: a.accountId, isAdmin });
  return { admin, member, server, library, artist, album, actor };
}

describe("albums and songs", () => {
  it("lists an artist's albums oldest first with counts and the first cover, and an album's songs in disc and track order", async () => {
    const w = await world();
    await w.album("Abbey Road", 1969, [
      { name: "Something", track: 2, poster: "/cover/2" },
      { name: "Come Together", track: 1, poster: "/cover/1", seconds: 260 },
      { name: "Hidden Reprise", track: null },
    ]);
    await w.album("Please Please Me", 1963, [{ name: "I Saw Her Standing There", track: 1 }]);
    await w.album("Undated", null, [{ name: "x", track: 1 }]);
    const scope = { actor: w.actor(w.member), viewer: adult };
    const albums = await listAlbums(db, { ...scope, libraryId: w.library.id, artistId: w.artist.id });
    expect(albums!.items.map((a) => [a.name, a.year, a.trackCount, a.coverUrl])).toEqual([
      ["Please Please Me", 1963, 1, null],
      ["Abbey Road", 1969, 3, "/cover/1"],
      ["Undated", null, 1, null],
    ]);
    const abbey = albums!.items[1];
    const page = await getAlbum(db, { ...scope, albumId: abbey.id });
    expect(page!.tracks.map((t) => [t.trackNumber, t.name, t.durationSeconds])).toEqual([[1, "Come Together", 260], [2, "Something", 100], [null, "Hidden Reprise", 100]]);
    expect(page!.totalSeconds).toBe(460);
    expect(page!.album).toMatchObject({ artistName: "The Beatles", libraryName: w.library.name });
  });

  it("puts discs in order, and shows a song's artist only when it differs from the album's", async () => {
    const w = await world();
    const a = await w.album("Double", 2000, [
      { name: "d2t1", track: 1, disc: 2 },
      { name: "d1t2", track: 2, disc: 1, authors: ["The Beatles"] },
      { name: "d1t1", track: 1, disc: 1, authors: ["Guest Singer"] },
    ]);
    const page = await getAlbum(db, { actor: w.actor(w.member), viewer: adult, albumId: a.id });
    expect(page!.tracks.map((t) => [t.name, t.artist])).toEqual([["d1t1", "Guest Singer"], ["d1t2", null], ["d2t1", null]]);
  });
});

describe("artists", () => {
  it("lists artists by sort name with album and song counts, and pages with a cursor", async () => {
    const w = await world();
    const names = ["Zed", "Alpha", "Mid"];
    for (const [i, name] of names.entries()) {
      const [ar] = await db.insert(musicArtists).values({ libraryId: w.library.id, name, nameKey: name.toLowerCase(), sortKey: name.toLowerCase() }).returning();
      await w.album(`${name} One`, 2000 + i, [{ name: "a", track: 1 }, { name: "b", track: 2 }], ar.id);
    }
    await w.album("Abbey Road", 1969, [{ name: "Something", track: 1, poster: "/c" }]);
    const scope = { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id };
    const first = await listArtists(db, { ...scope, limit: 2 });
    expect(first!.items.map((a) => [a.name, a.albumCount, a.trackCount])).toEqual([["Alpha", 1, 2], ["The Beatles", 1, 1]]);
    expect(first!.items[1].coverUrls).toEqual(["/c"]);
    const second = await listArtists(db, { ...scope, limit: 2, after: first!.next });
    expect(second!.items.map((a) => a.name)).toEqual(["Mid", "Zed"]);
    expect(second!.next).toBeNull();
  });

  it("fills an artist's tile with up to four covers, skipping albums that have none", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await w.album(`Plain ${i}`, 1960 + i, [{ name: "t", track: 1 }]);
    for (let i = 0; i < 5; i++) await w.album(`Covered ${i}`, 1980 + i, [{ name: "t", track: 1, poster: `/cover/${i}` }]);
    const r = await listArtists(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id });
    expect(r!.items[0].coverUrls).toEqual(["/cover/0", "/cover/1", "/cover/2", "/cover/3"]);
  });

  it("returns an artist with their albums", async () => {
    const w = await world();
    await w.album("Abbey Road", 1969, [{ name: "Something", track: 1 }]);
    const r = await getArtist(db, { actor: w.actor(w.member), viewer: adult, artistId: w.artist.id });
    expect(r!.artist).toMatchObject({ name: "The Beatles", libraryName: w.library.name });
    expect(r!.albums.map((a) => a.name)).toEqual(["Abbey Road"]);
  });

  it("pages albums by name across the library", async () => {
    const w = await world();
    for (const n of ["c", "a", "d", "b"]) await w.album(n, null, [{ name: "t", track: 1 }]);
    const scope = { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id };
    const p1 = await listAlbums(db, { ...scope, limit: 3 });
    expect(p1!.items.map((a) => a.name)).toEqual(["a", "b", "c"]);
    const p2 = await listAlbums(db, { ...scope, limit: 3, after: p1!.next });
    expect(p2!.items.map((a) => a.name)).toEqual(["d"]);
    expect(p2!.next).toBeNull();
  });
});

describe("access", () => {
  it("hides a restricted library from an ungranted account, shows it to a granted one and the admin", async () => {
    const w = await world("restricted");
    const a = await w.album("Abbey Road", 1969, [{ name: "Something", track: 1 }]);
    const ask = (who: LibraryActor) => ({ actor: who, viewer: adult });
    expect(await listArtists(db, { ...ask(w.actor(w.member)), libraryId: w.library.id })).toBeNull();
    expect(await listAlbums(db, { ...ask(w.actor(w.member)), libraryId: w.library.id })).toBeNull();
    expect(await getAlbum(db, { ...ask(w.actor(w.member)), albumId: a.id })).toBeNull();
    expect(await getArtist(db, { ...ask(w.actor(w.member)), artistId: w.artist.id })).toBeNull();
    await db.insert(libraryMembers).values({ libraryId: w.library.id, serverId: w.server.id, accountId: w.member.accountId });
    expect(await getAlbum(db, { ...ask(w.actor(w.member)), albumId: a.id })).not.toBeNull();
    await db.delete(libraryMembers).where(eq(libraryMembers.libraryId, w.library.id));
    expect(await getAlbum(db, { ...ask(w.actor(w.member)), albumId: a.id })).toBeNull();
    expect((await listArtists(db, { ...ask(w.actor(w.admin, true)), libraryId: w.library.id }))!.items).toHaveLength(1);
  });

  it("applies the age limit: an adults-only library shows nothing to an age-limited profile, not even an empty artist", async () => {
    const w = await world("everyone", { ANY: 18 });
    const a = await w.album("Abbey Road", 1969, [{ name: "Something", track: 1 }]);
    const asKid = { actor: w.actor(w.member), viewer: kid };
    expect((await listArtists(db, { ...asKid, libraryId: w.library.id }))!.items).toEqual([]);
    expect((await listAlbums(db, { ...asKid, libraryId: w.library.id }))!.items).toEqual([]);
    expect(await getAlbum(db, { ...asKid, albumId: a.id })).toBeNull();
    expect(await getArtist(db, { ...asKid, artistId: w.artist.id })).toBeNull();
    expect(await getAlbum(db, { actor: w.actor(w.member), viewer: adult, albumId: a.id })).not.toBeNull();
  });

  it("hides just the songs a profile may not see inside an album it can otherwise open", async () => {
    const w = await world();
    const a = await w.album("Mixed", 2000, [{ name: "Family friendly", track: 1 }]);
    const adultSong = await makeTitle(db, w.library.id, { kind: "audiobook", name: "Explicit", boxFolderId: `file:${Math.random()}`, albumId: a.id, trackNumber: 2, ratingAges: { ANY: 18 } });
    await db.update(titles).set({ ratingAges: { ANY: 0 } }).where(eq(titles.name, "Family friendly"));
    const asKid = { actor: w.actor(w.member), viewer: kid };
    const page = await getAlbum(db, { ...asKid, albumId: a.id });
    expect(page!.tracks.map((t) => t.name)).toEqual(["Family friendly"]);
    expect(page!.album.trackCount).toBe(1);
    expect((await getAlbum(db, { actor: w.actor(w.member), viewer: adult, albumId: a.id }))!.tracks.map((t) => t.name)).toEqual(["Family friendly", "Explicit"]);
    expect(adultSong.id).toBeTruthy();
  });

  it("keeps the servers apart: an album id from another server is just not found", async () => {
    const [one, two] = [await world(), await world()];
    const a = await one.album("Abbey Road", 1969, [{ name: "Something", track: 1 }]);
    expect(await getAlbum(db, { actor: two.actor(two.member), viewer: adult, albumId: a.id })).toBeNull();
    expect(await getArtist(db, { actor: two.actor(two.member), viewer: adult, artistId: one.artist.id })).toBeNull();
    expect(await listArtists(db, { actor: two.actor(two.member), viewer: adult, libraryId: one.library.id })).toBeNull();
  });

  it("only treats music libraries as music: an audio library's id is not found, and an album with no songs does not exist", async () => {
    const w = await world();
    const audio = await makeLibrary(db, w.server.id, "audio", "everyone");
    expect(await listArtists(db, { actor: w.actor(w.member), viewer: adult, libraryId: audio.id })).toBeNull();
    expect(await listAlbums(db, { actor: w.actor(w.member), viewer: adult, libraryId: audio.id })).toBeNull();
    const empty = await w.album("Empty", null, []);
    expect(await getAlbum(db, { actor: w.actor(w.member), viewer: adult, albumId: empty.id })).toBeNull();
    expect((await listAlbums(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id }))!.items).toEqual([]);
    expect((await listArtists(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id }))!.items).toEqual([]);
  });
});
