/**
 * Dating and describing photos: Box's date at scan time, the picture's own EXIF date after (and never
 * replaced by a rescan), stable thumbnail URLs, and the capped, retried metadata pass.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  files: new Map<string, Uint8Array>(),
  reads: [] as string[],
  failing: new Set<string>(),
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return { ...original, probeFiles: vi.fn(async () => false), probeCodecsForPending: vi.fn(async () => undefined) };
});

import { titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { MAX_META_ATTEMPTS, readPhotoMetadata } from "./photo-meta";
import { buildJpeg, buildPng, buildTiff, rangeOfBytes } from "./test-images";
import { PHOTOS_PROFILE } from "./tree-profile";
import { probeVideoLibrary, syncVideoDirectory } from "./video-library";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.reads.length = 0;
  h.failing.clear();
});

let n = 0;
const provider = {
  fetchByteRange: async (id: string, s: number, e: number) => {
    h.reads.push(id);
    if (h.failing.has(id)) throw new Error("Box: boom");
    return rangeOfBytes(h.files.get(id) ?? new Uint8Array(0))(s, e);
  },
} as unknown as StorageProvider;

const entry = (name: string, id: string, extra: Partial<StorageEntry> = {}): StorageEntry => ({ id, name, kind: "file", sizeBytes: 5000, ...extra });
async function photoLibrary() {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  return { lib: await makeLibrary(db, server.id, "photos", "everyone"), p: `pm${++n}-` };
}
const byKey = async (key: string) => (await db.select().from(titles).where(eq(titles.boxFolderId, key)))[0];
const sync = (libId: string, entries: StorageEntry[]) => syncVideoDirectory(libId, "d", "", entries, null, PHOTOS_PROFILE);
const run = (libId: string, errors: string[] = []) => readPhotoMetadata(provider, libId, Date.now() + 60_000, errors);

const BOX_DATE = new Date("2021-03-04T05:06:07.890Z");
const EXIF_JPEG = buildJpeg({ width: 4000, height: 3000, tiff: buildTiff({ orientation: 6, dateTimeOriginal: "2019:05:06 07:08:09" }) });

describe("dating at scan time", () => {
  it("dates every item from Box's created date (whole seconds), else its modified date, else the scan time", async () => {
    const { lib, p } = await photoLibrary();
    const before = Date.now();
    await sync(lib.id, [
      entry("a.jpg", `${p}a`, { createdAt: BOX_DATE, modifiedAt: new Date("2022-01-01T00:00:00Z") }),
      entry("b.jpg", `${p}b`, { modifiedAt: new Date("2022-01-01T00:00:00.500Z") }),
      entry("c.jpg", `${p}c`),
      entry("d.mp4", `${p}d`, { createdAt: BOX_DATE }),
    ]);
    const a = await byKey(`file:${p}a`);
    expect([a.takenAt?.toISOString(), a.takenAtSource]).toEqual(["2021-03-04T05:06:07.000Z", "box"]);
    const b = await byKey(`file:${p}b`);
    expect([b.takenAt?.toISOString(), b.takenAtSource]).toEqual(["2022-01-01T00:00:00.000Z", "box"]);
    const c = await byKey(`file:${p}c`);
    expect(c.takenAtSource).toBe("scan");
    expect(c.takenAt!.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(c.takenAt!.getTime() % 1000).toBe(0);
    expect((await byKey(`file:${p}d`)).takenAtSource).toBe("box"); // a video in the library is dated too
  });

  it("never touches dates in video or audio libraries", async () => {
    const admin = await makeAccount(db, "v");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    const { VIDEO_PROFILE } = await import("./tree-profile");
    await syncVideoDirectory(lib.id, "d", "", [entry("x.mp4", `vv${++n}`, { createdAt: BOX_DATE })], null, VIDEO_PROFILE);
    const t = (await db.select().from(titles).where(eq(titles.libraryId, lib.id)))[0];
    expect([t.takenAt, t.takenAtSource, t.posterUrl]).toEqual([null, null, null]);
  });

  it("a rescan updates a Box date but a scan-time guess never moves an existing date, and an EXIF date is never replaced", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.jpg", `${p}a`, { createdAt: BOX_DATE }), entry("b.jpg", `${p}b`), entry("c.jpg", `${p}c`, { createdAt: BOX_DATE })]);
    const guess = (await byKey(`file:${p}b`)).takenAt!;
    await db.update(titles).set({ takenAt: new Date("2019-05-06T07:08:09Z"), takenAtSource: "exif" }).where(eq(titles.boxFolderId, `file:${p}c`));
    await new Promise((r) => setTimeout(r, 1100));
    await sync(lib.id, [entry("a.jpg", `${p}a`, { createdAt: new Date("2020-02-02T02:02:02Z") }), entry("b.jpg", `${p}b`), entry("c.jpg", `${p}c`, { createdAt: new Date("2023-09-09T09:09:09Z") })]);
    expect((await byKey(`file:${p}a`)).takenAt?.toISOString()).toBe("2020-02-02T02:02:02.000Z"); // Box changed its mind
    expect((await byKey(`file:${p}b`)).takenAt).toEqual(guess); // still the first guess
    const c = await byKey(`file:${p}c`);
    expect([c.takenAt?.toISOString(), c.takenAtSource]).toEqual(["2019-05-06T07:08:09.000Z", "exif"]);
  });
});

describe("thumbnail URLs", () => {
  it("point each item at its own live thumbnail, unchanged by a rescan and changed by a replaced file", async () => {
    const { lib, p } = await photoLibrary();
    const e = (size: number) => [entry("a.jpg", `${p}a`, { sizeBytes: size, modifiedAt: BOX_DATE }), entry("v.mp4", `${p}v`, { sizeBytes: size, modifiedAt: BOX_DATE })];
    await sync(lib.id, e(5000));
    const first = await byKey(`file:${p}a`);
    expect(first.posterUrl).toMatch(new RegExp(`^/api/photos/${first.id}/thumb\\?v=[0-9a-z-]+$`));
    expect((await byKey(`file:${p}v`)).posterUrl).toContain(`/api/photos/${(await byKey(`file:${p}v`)).id}/thumb`);
    await sync(lib.id, e(5000));
    expect((await byKey(`file:${p}a`)).posterUrl).toBe(first.posterUrl); // a rescan changes nothing
    await sync(lib.id, e(6000));
    const replaced = await byKey(`file:${p}a`);
    expect(replaced.posterUrl).not.toBe(first.posterUrl);
    expect(replaced.posterUrl).toContain(`/api/photos/${first.id}/thumb?v=`);
  });
});

describe("the metadata pass", () => {
  it("replaces Box's date with the picture's own and records its size (turned by orientation)", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.jpg", `${p}a`, { createdAt: BOX_DATE })]);
    h.files.set(`${p}a`, EXIF_JPEG);
    await run(lib.id);
    const t = await byKey(`file:${p}a`);
    expect(t).toMatchObject({ takenAtSource: "exif", width: 3000, height: 4000, metaAttempts: 0 });
    expect(t.takenAt?.toISOString()).toBe("2019-05-06T07:08:09.000Z");
    expect(t.metaAttemptedAt).not.toBeNull();
  });

  it("keeps Box's date for a picture with no EXIF time, still records its size, and reads each picture only once", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.png", `${p}a`, { createdAt: BOX_DATE })]);
    h.files.set(`${p}a`, buildPng(640, 480));
    await run(lib.id);
    await run(lib.id);
    const t = await byKey(`file:${p}a`);
    expect(t).toMatchObject({ takenAtSource: "box", width: 640, height: 480 });
    expect(t.takenAt?.toISOString()).toBe("2021-03-04T05:06:07.000Z");
    expect(h.reads.filter((id) => id === `${p}a`)).toHaveLength(1);
  });

  it("never reads a video, a picture in another kind of library, or a file without a known size", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("v.mp4", `${p}v`), entry("nosize.jpg", `${p}n`, { sizeBytes: undefined })]);
    await run(lib.id);
    expect(h.reads).toEqual([]);
  });

  it("counts a failed read, retries it, and gives up after the cap; a later success clears the count", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.jpg", `${p}a`)]);
    h.files.set(`${p}a`, EXIF_JPEG);
    h.failing.add(`${p}a`);
    const errors: string[] = [];
    for (let i = 1; i <= MAX_META_ATTEMPTS; i++) {
      await run(lib.id, errors);
      const t = await byKey(`file:${p}a`);
      expect([t.metaAttempts, t.metaAttemptedAt]).toEqual([i, null]);
    }
    expect(errors).toHaveLength(MAX_META_ATTEMPTS);
    await run(lib.id, errors); // over the cap: not tried again
    expect(h.reads).toHaveLength(MAX_META_ATTEMPTS);
    // after a replacement resets the counters, a working read succeeds and leaves no failed attempts behind
    h.failing.clear();
    await db.update(titles).set({ metaAttempts: 1 }).where(eq(titles.boxFolderId, `file:${p}a`));
    await run(lib.id);
    expect(await byKey(`file:${p}a`)).toMatchObject({ metaAttempts: 0, takenAtSource: "exif" });
  });

  it("a garbage file doesn't fail the pass: it is read once and marked done with nothing learned", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("junk.jpg", `${p}j`, { createdAt: BOX_DATE })]);
    h.files.set(`${p}j`, Uint8Array.from(Array.from({ length: 5000 }, (_, i) => (i * 37) & 255)));
    const errors: string[] = [];
    await run(lib.id, errors);
    const t = await byKey(`file:${p}j`);
    expect(errors).toEqual([]);
    expect(t).toMatchObject({ takenAtSource: "box", width: null, height: null });
    expect(t.metaAttemptedAt).not.toBeNull();
  });

  it("a replaced picture is dated and measured afresh", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.jpg", `${p}a`, { sizeBytes: 5000, createdAt: BOX_DATE })]);
    h.files.set(`${p}a`, EXIF_JPEG);
    await run(lib.id);
    expect((await byKey(`file:${p}a`)).takenAtSource).toBe("exif");
    await sync(lib.id, [entry("a.jpg", `${p}a`, { sizeBytes: 7777, createdAt: BOX_DATE })]); // same id, new contents
    expect(await byKey(`file:${p}a`)).toMatchObject({ takenAtSource: "box", width: null, height: null, metaAttemptedAt: null });
    h.files.set(`${p}a`, buildJpeg({ width: 100, height: 200, tiff: buildTiff({ dateTimeOriginal: "2015:01:02 03:04:05" }) }));
    await run(lib.id);
    const t = await byKey(`file:${p}a`);
    expect([t.takenAt?.toISOString(), t.width, t.height]).toEqual(["2015-01-02T03:04:05.000Z", 100, 200]);
  });

  it("a replacement that lands while a picture is being read is not stamped with the old picture's date", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("a.jpg", `${p}a`, { sizeBytes: 5000, createdAt: BOX_DATE })]);
    h.files.set(`${p}a`, EXIF_JPEG);
    const racing = {
      fetchByteRange: async (id: string, s: number, e: number) => {
        await sync(lib.id, [entry("a.jpg", `${p}a`, { sizeBytes: 9999, createdAt: BOX_DATE })]); // replaced during the read
        return rangeOfBytes(h.files.get(id)!)(s, e);
      },
    } as unknown as StorageProvider;
    await readPhotoMetadata(racing, lib.id, Date.now() + 60_000, []);
    const t = await byKey(`file:${p}a`);
    expect([t.takenAtSource, t.width, t.metaAttemptedAt]).toEqual(["box", null, null]); // left for a fresh read
    await run(lib.id);
    expect((await byKey(`file:${p}a`)).takenAtSource).toBe("exif");
  });

  it("a video that becomes a picture loses its runtime and codecs", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, [entry("x.mp4", `${p}x`)]);
    const before = await byKey(`file:${p}x`);
    await db.update(titles).set({ runtimeSeconds: 90 }).where(eq(titles.id, before.id));
    await db.update((await import("@/lib/db/schema")).mediaFiles).set({ audioCodec: "ac-3", videoCodec: "avc1" }).where(eq((await import("@/lib/db/schema")).mediaFiles.ownerId, before.id));
    await sync(lib.id, [entry("x.jpg", `${p}x`)]);
    const after = await byKey(`file:${p}x`);
    expect(after).toMatchObject({ kind: "photo", runtimeSeconds: null });
    const m = (await db.select().from((await import("@/lib/db/schema")).mediaFiles).where(eq((await import("@/lib/db/schema")).mediaFiles.ownerId, after.id)))[0];
    expect([m.audioCodec, m.videoCodec]).toEqual([null, null]);
  });

  it("is part of probing a photo library, and its work-remaining flag keeps the scan going", async () => {
    const { lib, p } = await photoLibrary();
    await sync(lib.id, Array.from({ length: 101 }, (_, i) => entry(`p${i}.png`, `${p}${i}`)));
    for (let i = 0; i < 101; i++) h.files.set(`${p}${i}`, buildPng(10, 10));
    const incomplete = await probeVideoLibrary(provider, lib.id, Date.now() + 60_000, [], PHOTOS_PROFILE);
    expect(incomplete).toBe(true); // 100 per pass, one left
    const done = await db.select().from(titles).where(and(eq(titles.libraryId, lib.id), eq(titles.width, 10)));
    expect(done).toHaveLength(100);
    expect(await probeVideoLibrary(provider, lib.id, Date.now() + 60_000, [], PHOTOS_PROFILE)).toBe(false);
  });
});
