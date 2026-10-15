/** Lyrics are looked up once per song, kept, and only for songs. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { musicAlbums, musicArtists, trackLyrics } from "@/lib/db/schema";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { lyricsFor, RETRY_AFTER_MS, songOf } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const found = () => vi.fn(async () => new Response(JSON.stringify({ syncedLyrics: "[00:01.00]Hello\n[00:05.00]World", plainLyrics: "Hello\nWorld", instrumental: false }), { status: 200 }));
const none = () => vi.fn(async () => new Response("{}", { status: 404 }));

async function song(over: { kind?: "music" | "audio"; name?: string } = {}) {
  const admin = await makeAccount(db, `a${Math.random()}`);
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, over.kind ?? "music");
  const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "The Band", nameKey: "the band", sortKey: "band" }).returning();
  const [album] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: artist.id, name: "The Record", nameKey: "the record" }).returning();
  const t = await makeTitle(db, lib.id, { kind: "audiobook", name: over.name ?? "03 - The Song", albumId: album.id, runtimeSeconds: 215 });
  return { t, lib };
}

describe("a song's details", () => {
  it("come from the library: the name without its track number, the artist, the album and the length", async () => {
    const { t } = await song();
    expect(await songOf(db, t.id)).toEqual({ title: "The Song", artist: "The Band", album: "The Record", durationSeconds: 215 });
  });
  it("are null for anything in a library that isn't music or audio, or that isn't there", async () => {
    const admin = await makeAccount(db, "other");
    const server = await makeServer(db, admin.accountId);
    const books = await makeLibrary(db, server.id, "audiobooks");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "A Book" });
    expect(await songOf(db, book.id)).toBeNull();
    expect(await songOf(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
  it("use the file's own artist in a plain audio library", async () => {
    const admin = await makeAccount(db, "plain");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "audio");
    const t = await makeTitle(db, lib.id, { kind: "audiobook", name: "Track", authors: ["Solo Artist"] });
    expect(await songOf(db, t.id)).toMatchObject({ title: "Track", artist: "Solo Artist", album: null });
  });
});

describe("lyrics", () => {
  it("are looked up once, parsed into timed lines, and kept", async () => {
    const { t } = await song();
    const f = found();
    const first = await lyricsFor(db, t.id, { fetchImpl: f as never });
    expect(first).toEqual({ synced: [{ t: 1, text: "Hello" }, { t: 5, text: "World" }], plain: "Hello\nWorld", instrumental: false });
    expect(await lyricsFor(db, t.id, { fetchImpl: f as never })).toEqual(first);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("remember that there are none, and look again after a month", async () => {
    const { t } = await song();
    const f = none();
    const start = new Date("2026-01-01T00:00:00Z");
    expect(await lyricsFor(db, t.id, { fetchImpl: f as never, now: start })).toBeNull();
    expect(await lyricsFor(db, t.id, { fetchImpl: f as never, now: new Date(start.getTime() + RETRY_AFTER_MS - 1000) })).toBeNull();
    expect(f).toHaveBeenCalledTimes(2); // the one look: the exact song, then a search
    const later = found();
    expect(await lyricsFor(db, t.id, { fetchImpl: later as never, now: new Date(start.getTime() + RETRY_AFTER_MS + 1000) })).toMatchObject({ plain: "Hello\nWorld" });
  });
  it("keep nothing when the service can't be reached, so the next try asks again", async () => {
    const { t } = await song();
    expect(await lyricsFor(db, t.id, { fetchImpl: (async () => new Response("", { status: 503 })) as never })).toBeNull();
    expect(await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, t.id))).toEqual([]);
    expect(await lyricsFor(db, t.id, { fetchImpl: found() as never })).not.toBeNull();
  });
  it("are never asked for what isn't a song", async () => {
    const admin = await makeAccount(db, "nope");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "movies");
    const film = await makeTitle(db, lib.id, { kind: "movie", name: "Film" });
    const f = found();
    expect(await lyricsFor(db, film.id, { fetchImpl: f as never })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("can be words only, or an instrumental", async () => {
    const { t } = await song({ name: "Plain" });
    const plain = vi.fn(async () => new Response(JSON.stringify({ plainLyrics: "Just words", instrumental: false }), { status: 200 }));
    expect(await lyricsFor(db, t.id, { fetchImpl: plain as never })).toEqual({ synced: null, plain: "Just words", instrumental: false });
    const { t: t2 } = await song({ name: "Instr" });
    const inst = vi.fn(async () => new Response(JSON.stringify({ instrumental: true }), { status: 200 }));
    expect(await lyricsFor(db, t2.id, { fetchImpl: inst as never })).toEqual({ synced: null, plain: null, instrumental: true });
  });
});
