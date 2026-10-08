/** The TV pages for video, audio, music, photos and audiobook libraries, with sharing, age limits and server boundaries applied. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { musicAlbums, musicArtists, titles, watchState } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { bookDetail, continueWatching, folderLevel, listenInfo, parseFolderCursor, photoPage, photoView, tvLibrary, watchInfo, TV_FOLDER_PAGE, type TvScope } from "./data";

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
  const lib = (kind: Parameters<typeof makeLibrary>[2]) => makeLibrary(db, server.id, kind, access);
  const scope = (viewer = adult): TvScope => ({ actor: { serverId: server.id, accountId: member.accountId, isAdmin: false } satisfies LibraryActor, viewer, viewerId: member.viewer.id });
  return { server, member, lib, scope };
}

describe("tvLibrary", () => {
  it("opens a visible library of a TV kind, and nothing else", async () => {
    const w = await world();
    expect((await tvLibrary(db, w.scope(), (await w.lib("music")).id))?.kind).toBe("music");
    expect(await tvLibrary(db, w.scope(), (await w.lib("ebooks")).id)).toBeNull();
    const other = await world();
    expect(await tvLibrary(db, w.scope(), (await other.lib("photos")).id)).toBeNull();
    const hidden = await world("restricted");
    expect(await tvLibrary(db, hidden.scope(), (await hidden.lib("audio")).id)).toBeNull();
  });
});

describe("folderLevel (video and audio libraries)", () => {
  it("lists the folders and files at one level, by natural order, and pages", async () => {
    const w = await world();
    const lib = await w.lib("video");
    await makeTitle(db, lib.id, { kind: "movie", name: "Clip 10", folderPath: "Trips/Paris", sortKey: "clip 0000000010" });
    await makeTitle(db, lib.id, { kind: "movie", name: "Clip 2", folderPath: "Trips/Paris", sortKey: "clip 0000000002" });
    await makeTitle(db, lib.id, { kind: "movie", name: "Rome", folderPath: "Trips" });
    await makeTitle(db, lib.id, { kind: "movie", name: "Loose", folderPath: "" });
    const root = await folderLevel(db, w.scope(), lib.id, null, null);
    expect([root!.folders, root!.items.map((i) => i.name)]).toEqual([["Trips"], ["Loose"]]);
    const trips = await folderLevel(db, w.scope(), lib.id, "Trips", null);
    expect([trips!.folders, trips!.items.map((i) => i.name)]).toEqual([["Paris"], ["Rome"]]);
    expect((await folderLevel(db, w.scope(), lib.id, "Trips/Paris", null))!.items.map((i) => i.name)).toEqual(["Clip 2", "Clip 10"]);

    for (let i = 0; i < TV_FOLDER_PAGE + 3; i++) await makeTitle(db, lib.id, { kind: "movie", name: `Many ${String(i).padStart(2, "0")}`, folderPath: "Many" });
    const first = await folderLevel(db, w.scope(), lib.id, "Many", null);
    expect(first!.items).toHaveLength(TV_FOLDER_PAGE);
    const second = await folderLevel(db, w.scope(), lib.id, "Many", first!.nextCursor);
    expect(second!.items).toHaveLength(3);
    expect(second!.nextCursor).toBeNull();
  });
  it("is null for a missing folder, an unsafe path, another kind of library, a hidden library and another server's", async () => {
    const w = await world();
    const lib = await w.lib("audio");
    await makeTitle(db, lib.id, { kind: "audiobook", name: "Song", folderPath: "A" });
    expect(await folderLevel(db, w.scope(), lib.id, "Nope", null)).toBeNull();
    for (const bad of ["../x", "A//B", "/A", "A/"]) expect(await folderLevel(db, w.scope(), lib.id, bad, null), bad).toBeNull();
    expect(await folderLevel(db, w.scope(), (await w.lib("photos")).id, null, null)).toBeNull(); // photos have their own page
    expect(await folderLevel(db, w.scope(), (await w.lib("movies")).id, null, null)).toBeNull();
    const hidden = await world("restricted");
    expect(await folderLevel(db, hidden.scope(), (await hidden.lib("video")).id, null, null)).toBeNull();
    const other = await world();
    expect(await folderLevel(db, w.scope(), (await other.lib("video")).id, null, null)).toBeNull();
  });
  it("hides files and folders the age limit forbids, folder names included", async () => {
    const w = await world();
    const lib = await w.lib("video");
    await makeTitle(db, lib.id, { kind: "movie", name: "Cartoon", folderPath: "Kids", ratingAges: { ANY: 0 } });
    await makeTitle(db, lib.id, { kind: "movie", name: "Thriller", folderPath: "Adults Only", ratingAges: { ANY: 17 } });
    const level = await folderLevel(db, w.scope(kid), lib.id, null, null);
    expect(level!.folders).toEqual(["Kids"]);
    expect(await folderLevel(db, w.scope(kid), lib.id, "Adults Only", null)).toBeNull();
  });
  it("reads a cursor from a URL only when it is well formed", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(parseFolderCursor(null)).toBeNull();
    expect(parseFolderCursor(`clip 0000000002~${id}`)).toEqual({ key: "clip 0000000002", id });
    for (const bad of ["x", `~${id}`, "key~notanid", `key~${id}x`, `${"k".repeat(700)}~${id}`]) expect(parseFolderCursor(bad), bad).toBe("bad");
  });
});

describe("photos", () => {
  const at = (day: number) => new Date(Date.UTC(2024, 4, day, 12));
  it("lists a photo library newest first, with clips beside the pictures, and pages", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    for (let d = 1; d <= 31; d++) await makeTitle(db, lib.id, { kind: d === 31 ? "movie" : "photo", name: `P${d}`, takenAt: at(d) });
    const one = await photoPage(db, w.scope(), lib.id, null);
    expect(one!.items).toHaveLength(30);
    expect([one!.items[0].name, one!.items[0].kind]).toEqual(["P31", "movie"]);
    expect(one!.next).not.toBeNull();
    const two = await photoPage(db, w.scope(), lib.id, one!.next);
    expect(two!.items.map((i) => i.name)).toEqual(["P1"]);
    expect(two!.next).toBeNull();
  });
  it("is null for other kinds of library and for libraries it can't see", async () => {
    const w = await world();
    expect(await photoPage(db, w.scope(), (await w.lib("video")).id, null)).toBeNull();
    const hidden = await world("restricted");
    expect(await photoPage(db, hidden.scope(), (await hidden.lib("photos")).id, null)).toBeNull();
  });
  it("finds a picture with its neighbours by date, and hides one the age limit forbids", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const [a, b, c] = [await makeTitle(db, lib.id, { kind: "photo", name: "A", takenAt: at(1) }), await makeTitle(db, lib.id, { kind: "photo", name: "B", takenAt: at(2) }), await makeTitle(db, lib.id, { kind: "photo", name: "C", takenAt: at(3), ratingAges: { ANY: 17 } })];
    const view = await photoView(db, w.scope(), b.id, { kind: "timeline" });
    expect([view!.prev?.id ?? null, view!.next?.id]).toEqual([c.id, a.id]);
    const kidView = await photoView(db, w.scope(kid), b.id, { kind: "timeline" });
    expect(kidView).toBeNull(); // unrated, and this profile allows only rated
    const other = await world();
    expect(await photoView(db, other.scope(), a.id, { kind: "timeline" })).toBeNull();
  });
});

describe("audiobooks (bookDetail)", () => {
  it("shows an audiobook with where the profile left off, and nothing from other kinds of library", async () => {
    const w = await world();
    const books = await w.lib("audiobooks");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "The Hobbit", authors: ["J. R. R. Tolkien"], narrators: ["Rob Inglis"] });
    expect((await bookDetail(db, w.scope(), book.id))!.resume).toBeNull();
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: book.id, positionSeconds: 600, durationSeconds: 3600, finished: false });
    expect((await bookDetail(db, w.scope(), book.id))!.resume).toEqual({ positionSeconds: 600, durationSeconds: 3600 });
    const song = await makeTitle(db, (await w.lib("audio")).id, { kind: "audiobook", name: "A file" });
    expect(await bookDetail(db, w.scope(), song.id)).toBeNull();
    const hidden = await world("restricted");
    const secret = await makeTitle(db, (await hidden.lib("audiobooks")).id, { kind: "audiobook", name: "Secret" });
    expect(await bookDetail(db, hidden.scope(), secret.id)).toBeNull();
  });
});

describe("listenInfo", () => {
  async function album(w: Awaited<ReturnType<typeof world>>, names: string[]) {
    const lib = await w.lib("music");
    const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: artist.id, name: "Record", nameKey: "record" }).returning();
    const songs = [];
    for (const [i, name] of names.entries()) songs.push(await makeTitle(db, lib.id, { kind: "audiobook", name, albumId: al.id, trackNumber: i + 1, sortKey: String(i), authors: ["Band"] }));
    return { lib, al, songs };
  }
  it("goes from one song to the next on an album, and Back goes to the album; the last song has no next", async () => {
    const w = await world();
    const { al, songs } = await album(w, ["One", "Two", "Three"]);
    const one = await listenInfo(db, w.scope(), songs[0].id);
    expect(one).toMatchObject({ libraryKind: "music", remembers: false, back: `/album/${al.id}`, next: `/listen/${songs[1].id}`, subtitle: "Band" });
    expect((await listenInfo(db, w.scope(), songs[1].id))!.next).toBe(`/listen/${songs[2].id}`);
    expect((await listenInfo(db, w.scope(), songs[2].id))!.next).toBeNull();
  });
  it("skips songs the age limit hides when choosing the next one", async () => {
    const w = await world();
    const { songs } = await album(w, ["One", "Two", "Three"]);
    await db.update(titles).set({ ratingAges: { ANY: 0 } }).where(inArray(titles.id, [songs[0].id, songs[2].id]));
    await db.update(titles).set({ ratingAges: { ANY: 17 } }).where(eq(titles.id, songs[1].id));
    expect((await listenInfo(db, w.scope(), songs[0].id))!.next).toBe(`/listen/${songs[1].id}`); // an adult hears all three in order
    expect((await listenInfo(db, w.scope(kid), songs[0].id))!.next).toBe(`/listen/${songs[2].id}`); // a child's profile goes straight to the third
    expect(await listenInfo(db, w.scope(kid), songs[1].id)).toBeNull(); // and cannot open the hidden one
  });
  it("remembers the place for audiobooks and audio files, and sends Back to the book or the folder", async () => {
    const w = await world();
    const book = await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "Book" });
    expect(await listenInfo(db, w.scope(), book.id)).toMatchObject({ libraryKind: "audiobooks", remembers: true, back: `/book/${book.id}`, next: null });
    const audio = await w.lib("audio");
    const file = await makeTitle(db, audio.id, { kind: "audiobook", name: "Talk", folderPath: "Talks/2024" });
    expect(await listenInfo(db, w.scope(), file.id)).toMatchObject({ libraryKind: "audio", remembers: true, back: `/library/${audio.id}?path=Talks%2F2024` });
  });
  it("is null for a movie, a hidden library and another server's song", async () => {
    const w = await world();
    const movie = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    expect(await listenInfo(db, w.scope(), movie.id)).toBeNull();
    const hidden = await world("restricted");
    const secret = await makeTitle(db, (await hidden.lib("music")).id, { kind: "audiobook", name: "Secret" });
    expect(await listenInfo(db, hidden.scope(), secret.id)).toBeNull();
    const other = await world();
    const theirs = await makeTitle(db, (await other.lib("audio")).id, { kind: "audiobook", name: "Theirs" });
    expect(await listenInfo(db, w.scope(), theirs.id)).toBeNull();
  });
});

describe("continue listening and where Back goes from a clip", () => {
  it("lists unfinished audiobooks and audio files under listening, not under watching, and never songs", async () => {
    const w = await world();
    const book = await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "Book", authors: ["Someone"] });
    const talk = await makeTitle(db, (await w.lib("audio")).id, { kind: "audiobook", name: "Talk" });
    const song = await makeTitle(db, (await w.lib("music")).id, { kind: "audiobook", name: "Song" });
    const clip = await makeTitle(db, (await w.lib("video")).id, { kind: "movie", name: "Home clip" });
    for (const t of [book, talk, song, clip]) await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: t.id, positionSeconds: 100, durationSeconds: 1000, finished: false });
    const r = await continueWatching(db, w.scope());
    expect(r.listening.map((i) => i.name).sort()).toEqual(["Book", "Talk"]);
    expect(r.listening.find((i) => i.name === "Book")).toMatchObject({ kind: "listen", meta: "Someone", progress: 0.1 });
    expect(r.watching.map((i) => i.name)).toEqual(["Home clip"]);
  });
  it("sends Back from a video to its folder and from a photo-library clip to the picture viewer", async () => {
    const w = await world();
    const video = await w.lib("video");
    const clip = await makeTitle(db, video.id, { kind: "movie", name: "Clip", folderPath: "Trips/Paris" });
    expect((await watchInfo(db, w.scope(), "title", clip.id))!.back).toEqual({ kind: "folder", libraryId: video.id, path: "Trips/Paris" });
    const photoClip = await makeTitle(db, (await w.lib("photos")).id, { kind: "movie", name: "Photo clip", takenAt: new Date() });
    expect((await watchInfo(db, w.scope(), "title", photoClip.id))!.back).toEqual({ kind: "photo", id: photoClip.id });
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    expect((await watchInfo(db, w.scope(), "title", film.id))!.back).toEqual({ kind: "title", id: film.id });
  });
});
