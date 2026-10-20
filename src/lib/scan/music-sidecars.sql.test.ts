/** Lyric files and cover pictures beside songs, in Plex's naming. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, text: new Map<string, Uint8Array>() }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles, titleArtwork, titles, trackLyrics } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { placeTrack, usesPlexDiscNumbers } from "@/lib/music/placement";
import { albumCoverFile, lyricFileFor, syncMusicSidecars } from "./music-sidecars";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
const entry = (name: string, text?: string | Uint8Array, modifiedAt?: Date): StorageEntry => {
  const id = `m${++n}`;
  if (text !== undefined) h.text.set(id, typeof text === "string" ? new TextEncoder().encode(text) : text);
  return { id, name, kind: "file", sizeBytes: text === undefined ? 1000 : (typeof text === "string" ? new TextEncoder().encode(text).length : text.length), modifiedAt } as StorageEntry;
};
const provider = { fetchByteRange: async (id: string, s: number, e: number) => h.text.get(id)!.slice(s, e + 1).buffer } as never;

async function song(libraryId: string, file: StorageEntry) {
  const t = await makeTitle(db, libraryId, { kind: "audiobook", boxFolderId: `file:${file.id}` });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: file.id, filename: file.name, sizeBytes: 1000, container: "mp3", probeStatus: "ok" });
  return t;
}
async function music() {
  const owner = await makeAccount(db, `o${++n}`);
  const server = await makeServer(db, owner.accountId);
  return makeLibrary(db, server.id, "music", "everyone");
}

describe("which files are a song's", () => {
  it("lyrics: the same name, .lrc before .txt; cover: Plex's names in order", () => {
    const entries = [entry("01-Come With Me Tonight.mp3"), entry("01-Come With Me Tonight.txt"), entry("01-Come With Me Tonight.lrc"), entry("02-Medicine.TXT"), entry("folder.jpg"), entry("Cover.PNG"), entry("art.jpg")];
    expect(lyricFileFor("01-Come With Me Tonight.mp3", entries)?.name).toBe("01-Come With Me Tonight.lrc");
    expect(lyricFileFor("02-Medicine.mp3", entries)?.name).toBe("02-Medicine.TXT");
    expect(lyricFileFor("03-A Long Way To Get.mp3", entries)).toBeNull();
    expect(albumCoverFile(entries)?.name).toBe("Cover.PNG");
    expect(albumCoverFile([entry("poster.tbn"), entry("front.jpeg")])?.name).toBe("poster.tbn");
    expect(albumCoverFile([entry("artist-poster.jpg"), entry("background.jpg")])).toBeNull();
  });
});

describe("Plex's multi-disc numbering", () => {
  it("302 is disc 3, track 2 when the whole album is numbered that way, and a flat big number otherwise", () => {
    const wall = ["101 - In the Flesh.mp3", "102 - The Thin Ice.mp3", "201 - Hey You.mp3", "202 - Is There Anybody Out There.mp3"];
    expect(usesPlexDiscNumbers(wall)).toBe(true);
    expect(placeTrack({ folderPath: "Pink Floyd/The Wall", fileName: "201 - Hey You.mp3", plexDiscs: true })).toMatchObject({ artist: "Pink Floyd", album: "The Wall", disc: 2, track: 1, title: "Hey You" });
    expect(usesPlexDiscNumbers(["01 - Shine On.m4a", "02 - Welcome.mp3"])).toBe(false);
    expect(usesPlexDiscNumbers(["105 - Big Number.mp3"])).toBe(false);
    expect(usesPlexDiscNumbers(["099 - x.mp3", "101 - y.mp3"])).toBe(false);
    expect(placeTrack({ folderPath: "A/B", fileName: "105 - Big Number.mp3" })).toMatchObject({ disc: null, track: 105 });
  });
});

describe("syncMusicSidecars", () => {
  it("keeps timed and plain lyrics from files, leaves them alone until the file changes, and drops them with the file", async () => {
    const lib = await music();
    const a = entry("01-Come With Me Tonight.mp3");
    const b = entry("02-Medicine.mp3");
    const ta = await song(lib.id, a);
    const tb = await song(lib.id, b);
    const old = new Date("2026-01-01T00:00:00Z");
    const lrc = entry("01-Come With Me Tonight.lrc", "[ar:Bob]\n[00:01.00] Come with me\n[00:05.50] Tonight\n", old);
    const txt = entry("02-Medicine.txt", "Take your medicine\nAll of it\n", old);
    await syncMusicSidecars(provider, lib.id, [a, b, lrc, txt]);
    const rows = await db.select().from(trackLyrics).where(inArray(trackLyrics.titleId, [ta.id, tb.id]));
    const byTitle = new Map(rows.map((r) => [r.titleId, r]));
    expect(byTitle.get(ta.id)).toMatchObject({ source: "file", plain: "Come with me\nTonight" });
    expect(byTitle.get(ta.id)!.synced).toContain("[00:05.50]");
    expect(byTitle.get(tb.id)).toMatchObject({ source: "file", plain: "Take your medicine\nAll of it", synced: null });

    // Same file, same date: not read again (the bytes could even be gone).
    h.text.delete(lrc.id);
    await syncMusicSidecars(provider, lib.id, [a, b, lrc, txt]);
    expect((await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, ta.id)))[0].plain).toBe("Come with me\nTonight");
    // The file goes: so do its lyrics.
    await syncMusicSidecars(provider, lib.id, [a, b, txt]);
    expect(await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, ta.id))).toEqual([]);
    expect(await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, tb.id))).toHaveLength(1);
  });

  it("replaces looked-up lyrics, and never touches a song that has no file", async () => {
    const lib = await music();
    const a = entry("01-X.mp3");
    const ta = await song(lib.id, a);
    await db.insert(trackLyrics).values({ titleId: ta.id, plain: "from the internet", source: "lrclib" });
    await syncMusicSidecars(provider, lib.id, [a]);
    expect((await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, ta.id)))[0].plain).toBe("from the internet");
    await syncMusicSidecars(provider, lib.id, [a, entry("01-X.txt", "my words", new Date())]);
    expect((await db.select().from(trackLyrics).where(eq(trackLyrics.titleId, ta.id)))[0]).toMatchObject({ plain: "my words", source: "file" });
  });

  it("gives every song without a picture the folder's cover, and leaves a song with its own", async () => {
    const lib = await music();
    const a = entry("01-A.mp3");
    const b = entry("02-B.mp3");
    const ta = await song(lib.id, a);
    const tb = await song(lib.id, b);
    // A tiny JPEG: only its bytes matter.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const cover = entry("folder.jpg", jpeg);
    const { storeArtwork } = await import("./artwork-store");
    await storeArtwork(db, tb.id, { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 9]) }, "embedded");
    await syncMusicSidecars(provider, lib.id, [a, b, cover]);
    const art = await db.select().from(titleArtwork).where(inArray(titleArtwork.titleId, [ta.id, tb.id]));
    expect(art.find((x) => x.titleId === ta.id)?.source).toBe("box");
    expect(art.find((x) => x.titleId === tb.id)?.source).toBe("embedded");
    expect((await db.select().from(titles).where(eq(titles.id, ta.id)))[0].posterUrl).toContain(`/api/titles/${ta.id}/artwork`);
  });
});
