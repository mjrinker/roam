/** The audio flavour of the file-tree engine: what counts, what a file becomes, what the admin is told. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: {} as Record<string, import("@/lib/storage/provider").StorageEntry[]>,
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
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    listFolder: async (id: string) => h.tree[id] ?? [],
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "x", expiresAt: new Date() }),
    fetchByteRange: async () => new ArrayBuffer(0),
    fileExists: async (id: string) => !h.gone.has(id),
  }),
}));
const forbidden = vi.hoisted(() => (service: string) =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        typeof name === "symbol" || name === "then" || name === "__esModule"
          ? undefined
          : () => {
              throw new Error(`${service} must not be called (${String(name)})`);
            },
    }
  )
);
vi.mock("@/lib/tmdb/client", () => forbidden("TMDB"));
vi.mock("@/lib/omdb/client", () => forbidden("OMDb"));
vi.mock("@/lib/audible/client", () => ({ ...(forbidden("Audible") as object), AUDIBLE_REGIONS: { us: "us" }, AudibleRateLimitedError: class extends Error {}, AudibleUnavailableError: class extends Error {} }));

import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { scanLibrary } from "./scanner";
import { AUDIO_PROFILE, PHOTOS_PROFILE, VIDEO_PROFILE, treeProfileFor } from "./tree-profile";
import { syncVideoDirectory, unsupportedSummary } from "./video-library";
import { pruneMissingVideos, pruneNote, pruneSettings } from "./video-prune";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
  pruneSettings.graceMs = 0;
});

let n = 0;
const file = (name: string, id: string): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1000 });
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" });

async function audioLibrary() {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "audio", "everyone");
  return { lib, server, p: `au${++n}-` };
}
const titlesOf = (id: string) => db.select().from(titles).where(eq(titles.libraryId, id));

describe("profiles", () => {
  it("video keeps exactly what the engine did before; audio accepts mp3/m4a/m4b and reports other audio as unsupported", () => {
    expect(treeProfileFor("video")).toBe(VIDEO_PROFILE);
    expect(treeProfileFor("audio")).toBe(AUDIO_PROFILE);
    expect(VIDEO_PROFILE).toMatchObject({ titleKinds: ["movie"], linkVariants: true, probeCodecs: true, thumbnails: true, readTags: true });
    expect(AUDIO_PROFILE).toMatchObject({ titleKinds: ["audiobook"], linkVariants: false, probeCodecs: false, thumbnails: false, readTags: true });
    // Every file of a video library is a movie and every file of an audio library an audiobook, and each is probed.
    for (const f of ["a.mp4", "b.MOV", "c.m4v"]) expect([VIDEO_PROFILE.titleKindFor(f), VIDEO_PROFILE.needsProbe(f)], f).toEqual(["movie", true]);
    for (const f of ["a.mp3", "b.m4a", "c.m4b"]) expect([AUDIO_PROFILE.titleKindFor(f), AUDIO_PROFILE.needsProbe(f)], f).toEqual(["audiobook", true]);
    for (const f of ["a.mp3", "b.M4A", "c.m4b"]) expect(AUDIO_PROFILE.isMedia(f), f).toBe(true);
    for (const f of ["a.flac", "b.ogg", "c.wav", "d.opus", "e.WMA"]) {
      expect(AUDIO_PROFILE.isMedia(f), f).toBe(false);
      expect(AUDIO_PROFILE.isUnsupported(f), f).toBe(true);
    }
    expect(AUDIO_PROFILE.isUnsupported("movie.mkv")).toBe(false); // video formats aren't "unsupported audio"
    expect(VIDEO_PROFILE.isMedia("a.mp3")).toBe(false);
  });

  it("photos: pictures become photos with nothing to probe, videos stay movies, everything else is skipped and counted", () => {
    expect(treeProfileFor("photos")).toBe(PHOTOS_PROFILE);
    expect(PHOTOS_PROFILE).toMatchObject({ titleKinds: ["photo", "movie"], linkVariants: false, probeCodecs: false, thumbnails: false, readTags: false });
    for (const f of ["a.jpg", "b.JPEG", "c.png", "d.webp", "e.gif", "f.HEIC", "g.heif"]) {
      expect([PHOTOS_PROFILE.isMedia(f), PHOTOS_PROFILE.titleKindFor(f), PHOTOS_PROFILE.needsProbe(f)], f).toEqual([true, "photo", false]);
    }
    for (const f of ["a.mp4", "b.m4v", "c.MOV"]) {
      expect([PHOTOS_PROFILE.isMedia(f), PHOTOS_PROFILE.titleKindFor(f), PHOTOS_PROFILE.needsProbe(f)], f).toEqual([true, "movie", true]);
    }
    for (const f of ["a.cr2", "b.NEF", "c.dng", "d.tiff", "e.bmp", "f.avif", "g.mkv", "h.avi", "i.webm"]) {
      expect([PHOTOS_PROFILE.isMedia(f), PHOTOS_PROFILE.isUnsupported(f)], f).toEqual([false, true]);
    }
    for (const f of ["a.mp3", "notes.txt", "README", "x.jpg.part"]) expect([PHOTOS_PROFILE.isMedia(f), PHOTOS_PROFILE.isUnsupported(f)], f).toEqual([false, false]);
  });

  it("words notes with the right nouns", () => {
    expect(unsupportedSummary(2)).toBe("2 files skipped: unsupported format (Roam plays .mp4, .m4v and .mov).");
    expect(unsupportedSummary(1, AUDIO_PROFILE)).toBe("1 file skipped: unsupported format (Roam plays .mp3, .m4a and .m4b).");
    const base = { removed: 2, candidates: 2, unverified: 1, waiting: 0, skipped: null } as const;
    expect(pruneNote(base, AUDIO_PROFILE)).toBe("Removed 2 audio files that are no longer in Box. 1 audio file couldn't be checked against Box and was kept.");
    expect(pruneNote({ ...base, removed: 1, unverified: 0 }, AUDIO_PROFILE)).toBe("Removed 1 audio file that is no longer in Box.");
    expect(pruneNote({ ...base, removed: 0, unverified: 0, skipped: "too_many", candidates: 30 }, AUDIO_PROFILE)).toContain("30 audio files look like");
  });
});

describe("syncing an audio directory", () => {
  it("makes each audio file a one-part audiobook title, reports other audio formats, and never treats .aac names as remux copies", async () => {
    const { lib, p } = await audioLibrary();
    const r = await syncVideoDirectory(
      lib.id,
      "dir",
      "Podcasts",
      [file("Episode 1.mp3", `${p}1`), file("talk.m4a", `${p}2`), file("book.m4b", `${p}3`), file("song.flac", `${p}4`), file("clip.mp4", `${p}5`), file("x.m4a", `${p}6`), file("x.aac.m4a", `${p}7`)],
      null,
      AUDIO_PROFILE
    );
    expect(r).toMatchObject({ added: 5, seen: 5, unsupported: 1, conflicts: 0 });
    const rows = await titlesOf(lib.id);
    expect(rows.every((t) => t.kind === "audiobook" && t.folderPath === "Podcasts" && t.parentFolderId === "dir")).toBe(true);
    expect(rows.map((t) => t.name).sort()).toEqual(["Episode 1", "book", "talk", "x", "x aac"].sort()); // x.aac.m4a is its own file here
    // No remux links: every media file is a primary with no variant parent.
    const media = await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title")));
    expect(media.filter((m) => rows.some((t) => t.id === m.ownerId)).every((m) => m.variantOfMediaFileId === null && m.partIndex === 0)).toBe(true);
  });
});

describe("pruning an audio library", () => {
  it("removes audio titles gone from Box, only audiobook-kind rows with file keys in THAT library, and words it for audio", async () => {
    const { lib, p } = await audioLibrary();
    const cycle = crypto.randomUUID();
    await db.update(libraries).set({ scanCycleId: cycle }).where(eq(libraries.id, lib.id));
    await syncVideoDirectory(lib.id, "d", "", [file("keep.mp3", `${p}keep`), file("gone.mp3", `${p}gone`)], cycle, AUDIO_PROFILE);
    await db.update(titles).set({ lastSeenCycle: crypto.randomUUID() }).where(eq(titles.boxFolderId, `file:${p}gone`));
    h.gone.add(`${p}gone`);
    // A real folder-keyed audiobook in a different library must be untouchable, and a stray non-audio row in this one too.
    const other = await makeLibrary(db, (await makeServer(db, (await makeAccount(db, "o")).accountId)).id, "audiobooks", "everyone");
    await db.insert(titles).values({ libraryId: other.id, kind: "audiobook", name: "Real Audiobook", boxFolderId: "folder-123", lastSeenCycle: null });
    await db.insert(titles).values({ libraryId: lib.id, kind: "movie", name: "Stray", boxFolderId: `file:${p}stray`, lastSeenCycle: null });
    h.gone.add(`${p}stray`);

    const r = await pruneMissingVideos({ fileExists: async (id: string) => !h.gone.has(id) }, lib.id, cycle, Date.now() + 60_000, AUDIO_PROFILE);
    expect(r).toMatchObject({ removed: 1, candidates: 1 });
    expect(pruneNote(r, AUDIO_PROFILE)).toBe("Removed 1 audio file that is no longer in Box.");
    expect((await titlesOf(lib.id)).map((t) => t.name).sort()).toEqual(["Stray", "keep"]); // the stray movie row is not an audio candidate
    expect(await titlesOf(other.id)).toHaveLength(1);
  });
});

describe("a whole scan of an audio library", () => {
  it("syncs nested folders, never calls an outside service, reports skipped formats in audio terms, and finishes a clean cycle", async () => {
    const { lib, p } = await audioLibrary();
    h.gone.clear();
    h.tree = {
      [lib.boxFolderId]: [file("loose.mp3", `${p}loose`), file("skip.flac", `${p}skip`), folder(`${p}pod`, "Podcasts")],
      [`${p}pod`]: [file("ep1.mp3", `${p}ep1`), file("ep2.m4a", `${p}ep2`), file("old.wav", `${p}old`)],
    };
    const result = await scanLibrary(lib.id, "manual");
    expect(result.errors).toEqual(["2 files skipped: unsupported format (Roam plays .mp3, .m4a and .m4b)."]);
    expect(result.incomplete).toBe(false);
    const rows = await titlesOf(lib.id);
    expect(Object.fromEntries(rows.map((t) => [t.name, t.folderPath]))).toEqual({ loose: "", ep1: "Podcasts", ep2: "Podcasts" });
    expect(rows.every((t) => t.kind === "audiobook")).toBe(true);
    const [after] = await db.select().from(libraries).where(eq(libraries.id, lib.id));
    expect(after.scanCursor).toBeNull();
    expect(after.scanCycleId).not.toBeNull();
    // A rescan is idempotent.
    expect((await scanLibrary(lib.id, "manual")).titlesAdded).toBe(0);
    expect((await titlesOf(lib.id)).length).toBe(3);
  });
});
