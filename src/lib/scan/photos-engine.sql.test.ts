/**
 * The photo flavour of the file-tree engine: a library holds pictures AND videos, each file gets its
 * own kind, pictures are never probed or tag-read, a file that changes kind is reset, and cleanup
 * covers both kinds. Runs against real constraints (pglite) with Box and the outside services stubbed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  fetches: [] as string[],
  gone: new Set<string>(),
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

import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { probeFiles } from "@/lib/scan/media-files";
import { PHOTOS_PROFILE, VIDEO_PROFILE } from "./tree-profile";
import { probeVideoLibrary, syncVideoDirectory } from "./video-library";
import { pruneMissingVideos, pruneSettings } from "./video-prune";
import { readTagsAndArtwork } from "./video-artwork";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
  pruneSettings.graceMs = 0;
});
beforeEach(() => {
  h.fetches.length = 0;
  vi.mocked(probeFiles).mockClear();
});

let n = 0;
const file = (name: string, id: string, sizeBytes = 1000): StorageEntry => ({ id, name, kind: "file", sizeBytes });
const spyProvider = {
  fetchByteRange: async (id: string) => (h.fetches.push(id), new ArrayBuffer(0)),
  fetchThumbnail: async (id: string) => (h.fetches.push(`thumb:${id}`), undefined),
  fileExists: async (id: string) => !h.gone.has(id),
} as unknown as StorageProvider;

async function photoLibrary() {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  return { lib, admin, p: `ph${++n}-` };
}
const titlesOf = (libraryId: string) => db.select().from(titles).where(eq(titles.libraryId, libraryId));
const mediaOf = async (titleId: string) => (await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId))))[0];
const byKey = async (key: string) => (await db.select().from(titles).where(eq(titles.boxFolderId, key)))[0];

describe("syncing a photo directory", () => {
  it("makes pictures photos (born probed) and videos movies (to be probed), and counts what it can't show", async () => {
    const { lib, p } = await photoLibrary();
    const r = await syncVideoDirectory(
      lib.id,
      "dir",
      "Trip",
      [file("IMG_1.jpg", `${p}1`), file("IMG_2.HEIC", `${p}2`), file("a.png", `${p}3`), file("clip.mov", `${p}4`), file("b.mp4", `${p}5`), file("raw.CR2", `${p}6`), file("old.avi", `${p}7`), file("notes.txt", `${p}8`)],
      null,
      PHOTOS_PROFILE
    );
    expect(r).toMatchObject({ added: 5, seen: 5, unsupported: 2, conflicts: 0 });
    const rows = await titlesOf(lib.id);
    expect(Object.fromEntries(rows.map((t) => [t.boxFolderId, t.kind]))).toEqual({
      [`file:${p}1`]: "photo", [`file:${p}2`]: "photo", [`file:${p}3`]: "photo", [`file:${p}4`]: "movie", [`file:${p}5`]: "movie",
    });
    const probe = Object.fromEntries(await Promise.all(rows.map(async (t) => [t.kind + t.boxFolderId, (await mediaOf(t.id)).probeStatus] as const)));
    for (const [k, status] of Object.entries(probe)) expect(status, k).toBe(k.startsWith("photo") ? "ok" : "pending");
  });

  it("copies the library's rating onto pictures and videos alike", async () => {
    const { lib, p } = await photoLibrary();
    await db.update(libraries).set({ ratingAges: { ANY: 12 } as never }).where(eq(libraries.id, lib.id));
    await syncVideoDirectory(lib.id, "d", "", [file("a.jpg", `${p}a`), file("b.mp4", `${p}b`)], null, PHOTOS_PROFILE);
    expect((await titlesOf(lib.id)).map((t) => t.ratingAges)).toEqual([{ ANY: 12 }, { ANY: 12 }]);
  });
});

describe("probing and tag reading never touch a picture", () => {
  it("hands the prober only videos, and never reads a picture's bytes or asks for its thumbnail", async () => {
    const { lib, p } = await photoLibrary();
    await syncVideoDirectory(lib.id, "d", "", [file("a.jpg", `${p}a`), file("b.heic", `${p}b`), file("v.mp4", `${p}v`)], null, PHOTOS_PROFILE);
    // Even a picture whose media row were left 'pending' (a bug elsewhere) must not reach the prober.
    await db.update(mediaFiles).set({ probeStatus: "pending" }).where(eq(mediaFiles.boxFileId, `${p}a`));
    await probeVideoLibrary(spyProvider, lib.id, Date.now() + 60_000, [], PHOTOS_PROFILE);
    const handed = vi.mocked(probeFiles).mock.calls.flatMap((c) => (c[1] as { boxFileId: string }[]).map((f) => f.boxFileId));
    expect(handed).toEqual([`${p}v`]);
    expect(h.fetches).toEqual([]);
  });

  it("the tag and thumbnail pass skips photo-kind titles even when asked directly", async () => {
    const { lib, p } = await photoLibrary();
    await syncVideoDirectory(lib.id, "d", "", [file("a.jpg", `${p}a`)], null, PHOTOS_PROFILE);
    await readTagsAndArtwork(spyProvider, lib.id, Date.now() + 60_000, [], VIDEO_PROFILE);
    const t = await byKey(`file:${p}a`);
    expect([t.tagsAttemptedAt, t.tagAttempts, t.thumbAttempts]).toEqual([null, 0, 0]);
    expect(h.fetches).toEqual([]);
  });
});

describe("a file that changes kind", () => {
  it("picture -> video: becomes a movie that will be probed, with the picture's metadata cleared", async () => {
    const { lib, p } = await photoLibrary();
    await syncVideoDirectory(lib.id, "d", "", [file("x.jpg", `${p}x`)], null, PHOTOS_PROFILE);
    const before = await byKey(`file:${p}x`);
    await db.update(titles).set({ takenAtSource: "exif", width: 400, height: 300, metaAttempts: 2, metaAttemptedAt: new Date() }).where(eq(titles.id, before.id));
    await syncVideoDirectory(lib.id, "d", "", [file("x.mp4", `${p}x`)], null, PHOTOS_PROFILE);
    const after = await byKey(`file:${p}x`);
    expect(after).toMatchObject({ id: before.id, kind: "movie", takenAtSource: null, width: null, height: null, metaAttempts: 0, metaAttemptedAt: null });
    expect((await mediaOf(after.id)).probeStatus).toBe("pending");
  });

  it("video -> picture: becomes a photo with nothing to probe, and its watch progress is dropped", async () => {
    const { lib, admin, p } = await photoLibrary();
    await syncVideoDirectory(lib.id, "d", "", [file("x.mp4", `${p}x`)], null, PHOTOS_PROFILE);
    const before = await byKey(`file:${p}x`);
    await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 60 }).where(eq(mediaFiles.ownerId, before.id));
    await db.insert(watchState).values({ viewerId: admin.viewer.id, ownerKind: "title", ownerId: before.id, positionSeconds: 12 });
    await syncVideoDirectory(lib.id, "d", "", [file("x.jpg", `${p}x`)], null, PHOTOS_PROFILE);
    const after = await byKey(`file:${p}x`);
    expect(after).toMatchObject({ id: before.id, kind: "photo" });
    expect(await mediaOf(after.id)).toMatchObject({ probeStatus: "ok", durationSeconds: null });
    expect(await db.select().from(watchState).where(eq(watchState.ownerId, before.id))).toEqual([]);
  });

  it("a picture replaced in place stays 'ok' (never sent to the prober); a replaced video is probed again", async () => {
    const { lib, p } = await photoLibrary();
    await syncVideoDirectory(lib.id, "d", "", [file("a.jpg", `${p}a`, 1000), file("v.mp4", `${p}v`, 1000)], null, PHOTOS_PROFILE);
    await db.update(mediaFiles).set({ probeStatus: "ok" }).where(eq(mediaFiles.boxFileId, `${p}v`));
    await syncVideoDirectory(lib.id, "d", "", [file("a.jpg", `${p}a`, 2222), file("v.mp4", `${p}v`, 2222)], null, PHOTOS_PROFILE);
    expect((await mediaOf((await byKey(`file:${p}a`)).id)).probeStatus).toBe("ok");
    expect((await mediaOf((await byKey(`file:${p}v`)).id)).probeStatus).toBe("pending");
  });

  it("a video library never changes a title's kind", async () => {
    const admin = await makeAccount(db, "v");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    const id = `vid${++n}`;
    await syncVideoDirectory(lib.id, "d", "", [file("a.mp4", id)], null, VIDEO_PROFILE);
    await syncVideoDirectory(lib.id, "d", "", [file("a.mp4", id, 5000)], null, VIDEO_PROFILE);
    expect((await byKey(`file:${id}`)).kind).toBe("movie");
  });
});

describe("pruning a photo library", () => {
  it("removes pictures and videos gone from Box and leaves everything else (other kinds, other libraries)", async () => {
    const { lib, p } = await photoLibrary();
    const cycle = crypto.randomUUID();
    await db.update(libraries).set({ scanCycleId: cycle }).where(eq(libraries.id, lib.id));
    await syncVideoDirectory(lib.id, "d", "", [file("keep.jpg", `${p}keep`), file("gone.jpg", `${p}gonep`), file("gone.mp4", `${p}gonev`)], cycle, PHOTOS_PROFILE);
    await db.update(titles).set({ lastSeenCycle: crypto.randomUUID() }).where(and(eq(titles.libraryId, lib.id)));
    await db.update(titles).set({ lastSeenCycle: cycle }).where(eq(titles.boxFolderId, `file:${p}keep`));
    h.gone.add(`${p}gonep`);
    h.gone.add(`${p}gonev`);
    // A stray audiobook-kind row in this library is not a candidate.
    await db.insert(titles).values({ libraryId: lib.id, kind: "audiobook", name: "Stray", boxFolderId: `file:${p}stray`, lastSeenCycle: null });
    h.gone.add(`${p}stray`);

    const r = await pruneMissingVideos(spyProvider as never, lib.id, cycle, Date.now() + 60_000, PHOTOS_PROFILE);
    expect(r).toMatchObject({ removed: 2, candidates: 2 });
    expect((await titlesOf(lib.id)).map((t) => t.name).sort()).toEqual(["Stray", "keep"]);
  });
});
