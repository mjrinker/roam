/** Audio libraries: tags from MP3 and M4A/M4B files onto the title, no Box thumbnails, and chapters for the player. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return { ...original, probeFiles: vi.fn(async () => false), probeCodecsForPending: vi.fn(async () => undefined) };
});

import { mediaFiles, titles } from "@/lib/db/schema";
import { artworkOf, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageProvider } from "@/lib/storage/provider";
import { AUDIO_PROFILE } from "./tree-profile";
import { readTagsAndArtwork } from "./video-artwork";
import { copyEmbeddedChapters, probeVideoLibrary, syncVideoDirectory } from "./video-library";
import { mp3WithTags, mp4WithTags, rangeOf, TEST_JPEG } from "./test-mp4";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function setup(files: { name: string; bytes: Uint8Array }[]) {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "audio", "everyone");
  const prefix = `aud${++n}-`;
  await syncVideoDirectory(
    lib.id,
    "p",
    "",
    files.map((f, i) => ({ id: `${prefix}${i}`, name: f.name, kind: "file" as const, sizeBytes: f.bytes.length })),
    null,
    AUDIO_PROFILE
  );
  await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 60 });
  const bytesById = new Map(files.map((f, i) => [`${prefix}${i}`, f.bytes]));
  const provider = {
    listFolder: async () => [],
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }),
    fetchByteRange: vi.fn(async (id: string, s: number, e: number) => rangeOf(bytesById.get(id)!)(s, e)),
    fetchThumbnail: vi.fn(async () => ({ contentType: "image/jpeg" as const, bytes: Uint8Array.from(TEST_JPEG) })),
  } satisfies StorageProvider;
  const rows = async () => Object.fromEntries((await db.select().from(titles).where(eq(titles.libraryId, lib.id))).map((t) => [t.boxFolderId, t]));
  return { lib, provider, key: (i: number) => `file:${prefix}${i}`, rows };
}
const run = (t: Awaited<ReturnType<typeof setup>>) => readTagsAndArtwork(t.provider, t.lib.id, Date.now() + 60_000, [], AUDIO_PROFILE);

describe("audio tags onto titles", () => {
  it("reads an MP3: title, artist as author, album as series, year, and the cover", async () => {
    const t = await setup([{ name: "track01.mp3", bytes: mp3WithTags({ title: "Intro", artist: "The Speaker", album: "Season One", year: "2020", cover: TEST_JPEG }) }]);
    await run(t);
    const title = (await t.rows())[t.key(0)];
    expect(title).toMatchObject({ name: "Intro", nameSource: "embedded", authors: ["The Speaker"], seriesName: "Season One", year: 2020, kind: "audiobook" });
    const art = (await artworkOf(db, title.id))!;
    expect([art.source, Array.from(art.bytes)]).toEqual(["embedded", TEST_JPEG]);
    expect(title.posterUrl).toContain(`/api/titles/${title.id}/artwork`);
  });

  it("reads an M4A/M4B the same way, including the description as the overview", async () => {
    const t = await setup([{ name: "book.m4b", bytes: mp4WithTags({ title: "A Long Book", artist: "Some Author", album: "The Series", description: "What it is about.", year: "2015" }) }]);
    await run(t);
    expect((await t.rows())[t.key(0)]).toMatchObject({ name: "A Long Book", authors: ["Some Author"], seriesName: "The Series", overview: "What it is about.", year: 2015 });
  });

  it("only uses the album as a series when it isn't just the title again (an m4b's album usually is)", async () => {
    const same = await setup([{ name: "x.m4b", bytes: mp4WithTags({ title: "The Hobbit", album: "the hobbit" }) }]);
    await run(same);
    expect((await same.rows())[same.key(0)].seriesName).toBeNull();
    const withoutTitleTag = await setup([{ name: "The Hobbit.mp3", bytes: mp3WithTags({ album: "The Hobbit" }) }]); // falls back to the filename-derived name
    await run(withoutTitleTag);
    expect((await withoutTitleTag.rows())[withoutTitleTag.key(0)].seriesName).toBeNull();
  });

  it("clears a stale author when a (re)read finds no artist, and keeps the filename name for an untagged file", async () => {
    const t = await setup([{ name: "plain recording.mp3", bytes: mp3WithTags() }]);
    await db.update(titles).set({ authors: ["Old Artist"], seriesName: "Old Series" }).where(eq(titles.libraryId, t.lib.id));
    await run(t);
    const title = (await t.rows())[t.key(0)];
    expect(title).toMatchObject({ name: "plain recording", nameSource: "filename", authors: null, seriesName: null });
    expect(title.tagsAttemptedAt).not.toBeNull();
  });

  it("never asks Box for a thumbnail in an audio library, so a cover-less file simply has no picture", async () => {
    const t = await setup([{ name: "nocover.mp3", bytes: mp3WithTags({ title: "No Cover" }) }]);
    await run(t);
    await run(t);
    expect(t.provider.fetchThumbnail).not.toHaveBeenCalled();
    expect((await t.rows())[t.key(0)].posterUrl).toBeNull();
  });

  it("stores a tag whose cut falls inside an emoji, and one with a lone surrogate, without losing the title or cover", async () => {
    const t = await setup([
      { name: "emoji.mp3", bytes: mp3WithTags({ title: "Emoji Test", artist: "a".repeat(299) + "😀😀", cover: TEST_JPEG }) },
      { name: "m4a.m4a", bytes: mp4WithTags({ title: "Surrogate \ud800 Test", artist: "a".repeat(299) + "😀😀", cover: TEST_JPEG }) },
    ]);
    const errors: string[] = [];
    await readTagsAndArtwork(t.provider, t.lib.id, Date.now() + 60_000, errors, AUDIO_PROFILE);
    expect(errors).toEqual([]);
    const rows = await t.rows();
    for (const key of [t.key(0), t.key(1)]) {
      expect(rows[key].tagsAttemptedAt, key).not.toBeNull();
      expect(rows[key].tagAttempts, key).toBe(0);
      expect(rows[key].posterUrl, key).toContain("/artwork");
      expect(Array.from(rows[key].authors![0])).toHaveLength(300); // whole characters, ending on an emoji
      expect(rows[key].authors![0]).toBe(rows[key].authors![0].toWellFormed());
    }
    expect(rows[t.key(0)].name).toBe("Emoji Test");
  });

  it("reads each file with the right reader (ID3 for .mp3, MP4 atoms for .m4a) in the same library", async () => {
    const t = await setup([
      { name: "a.mp3", bytes: mp3WithTags({ title: "From ID3" }) },
      { name: "b.m4a", bytes: mp4WithTags({ title: "From MP4" }) },
    ]);
    await run(t);
    const rows = await t.rows();
    expect([rows[t.key(0)].name, rows[t.key(1)].name]).toEqual(["From ID3", "From MP4"]);
  });
});

describe("chapters for the audio player", () => {
  const chapters = [
    { title: "One", startSeconds: 0 },
    { title: "Two", startSeconds: 30 },
  ];

  it("copies a probed file's embedded chapters onto its title, marked embedded, and leaves everything else alone", async () => {
    const t = await setup([
      { name: "chaptered.m4b", bytes: mp4WithTags() },
      { name: "plain.mp3", bytes: mp3WithTags() },
      { name: "already.m4b", bytes: mp4WithTags() },
    ]);
    const idOf = async (i: number) => (await t.rows())[t.key(i)].id;
    await db.update(mediaFiles).set({ chapters }).where(eq(mediaFiles.boxFileId, t.key(0).slice(5)));
    await db.update(mediaFiles).set({ chapters: [] }).where(eq(mediaFiles.boxFileId, t.key(1).slice(5))); // empty list: nothing to copy
    await db.update(mediaFiles).set({ chapters: [{ title: "Fresh", startSeconds: 0 }] }).where(eq(mediaFiles.boxFileId, t.key(2).slice(5)));
    await db.update(titles).set({ chapters: [{ title: "Kept", startSeconds: 0 }], chaptersSource: "files" }).where(eq(titles.id, await idOf(2)));

    await copyEmbeddedChapters(t.lib.id);
    const rows = await t.rows();
    expect([rows[t.key(0)].chapters, rows[t.key(0)].chaptersSource]).toEqual([chapters, "embedded"]);
    expect([rows[t.key(1)].chapters, rows[t.key(1)].chaptersSource]).toEqual([null, null]);
    expect(rows[t.key(2)].chapters).toEqual([{ title: "Kept", startSeconds: 0 }]); // never overwritten
  });

  it("doesn't copy from a file that hasn't been probed successfully", async () => {
    const t = await setup([{ name: "later.m4b", bytes: mp4WithTags() }]);
    await db.update(mediaFiles).set({ chapters, probeStatus: "pending" });
    await copyEmbeddedChapters(t.lib.id);
    expect((await t.rows())[t.key(0)].chapters).toBeNull();
  });

  it("runs as part of probing an audio library, and not for video", async () => {
    const audio = await setup([{ name: "book.m4b", bytes: mp4WithTags() }]);
    await db.update(mediaFiles).set({ chapters });
    await probeVideoLibrary(audio.provider, audio.lib.id, Date.now() + 60_000, [], AUDIO_PROFILE);
    expect((await audio.rows())[audio.key(0)].chapters).toEqual(chapters);
  });

  it("does not run for a video library: chapters stay on the file", async () => {
    const admin = await makeAccount(db, "v");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    await syncVideoDirectory(lib.id, "p", "", [{ id: `vid${++n}`, name: "movie.mp4", kind: "file", sizeBytes: 100 }]);
    await db.update(mediaFiles).set({ probeStatus: "ok", chapters });
    await probeVideoLibrary({ fetchByteRange: async () => new ArrayBuffer(0), listFolder: async () => [], getFolder: async () => null, getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }) }, lib.id, Date.now() + 60_000, []);
    const [row] = await db.select().from(titles).where(eq(titles.libraryId, lib.id));
    expect(row.chapters).toBeNull();
  });

  it("a file replaced in place gets its chapters (and tags) read again", async () => {
    const t = await setup([{ name: "swap.m4b", bytes: mp4WithTags() }]);
    await db.update(mediaFiles).set({ chapters });
    await copyEmbeddedChapters(t.lib.id);
    expect((await t.rows())[t.key(0)].chapters).toEqual(chapters);
    const id = t.key(0).slice(5);
    await syncVideoDirectory(t.lib.id, "p", "", [{ id, name: "swap.m4b", kind: "file", sizeBytes: 123_456 }], null, AUDIO_PROFILE);
    const after = (await t.rows())[t.key(0)];
    expect([after.chapters, after.chaptersSource, after.tagsAttemptedAt]).toEqual([null, null, null]);
  });
});
