/** Reading tags and artwork for video titles: embedded covers, Box thumbnails, retries and caps. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles, titleArtwork, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageProvider } from "@/lib/storage/provider";
import { MAX_TAG_ATTEMPTS, readTagsAndArtwork } from "./video-artwork";
import { syncVideoDirectory } from "./video-library";
import { mp4WithTags, rangeOf, TEST_JPEG } from "./test-mp4";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function setup(files: { name: string; bytes: Uint8Array | null; probed?: boolean }[]) {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "video", "everyone");
  const prefix = `art${++n}-`;
  await syncVideoDirectory(lib.id, "p", "", files.map((f, i) => ({ id: `${prefix}${i}`, name: f.name, kind: "file" as const, sizeBytes: f.bytes?.length ?? 1000 })));
  for (const [i, f] of files.entries()) {
    if (f.probed !== false) await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 60 }).where(eq(mediaFiles.boxFileId, `${prefix}${i}`));
  }
  const bytesById = new Map(files.map((f, i) => [`${prefix}${i}`, f.bytes]));
  const thumbs = new Map<string, Uint8Array | null | "throw">();
  const provider = {
    listFolder: async () => [],
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }),
    fetchByteRange: vi.fn(async (id: string, s: number, e: number) => {
      const b = bytesById.get(id);
      if (!b) throw new Error("Box: file unavailable");
      return rangeOf(b)(s, e);
    }),
    fetchThumbnail: vi.fn(async (id: string) => {
      const t = thumbs.get(id);
      if (t === "throw") throw new Error("Box: thumbnail error");
      return t ? { contentType: "image/jpeg" as const, bytes: t } : null;
    }),
  } satisfies StorageProvider;
  const byName = async () => Object.fromEntries((await db.select().from(titles).where(eq(titles.libraryId, lib.id))).map((t) => [t.name, t]));
  return { lib, provider, thumbs, ids: (i: number) => `${prefix}${i}`, byName };
}
const farFuture = () => Date.now() + 60_000;

describe("readTagsAndArtwork", () => {
  it("names a title from its own tags, keeps the description, and stores the embedded cover", async () => {
    const t = await setup([{ name: "IMG_0001.mp4", bytes: mp4WithTags({ title: "Beach Day", year: "2019-07-04", description: "Waves and sand.", cover: TEST_JPEG }) }]);
    const incomplete = await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    expect(incomplete).toBe(false);
    const [title] = Object.values(await t.byName());
    expect(title).toMatchObject({ name: "Beach Day", year: 2019, overview: "Waves and sand.", nameSource: "embedded", tagAttempts: 0 });
    expect(title.tagsAttemptedAt).not.toBeNull();
    expect(title.posterUrl).toMatch(new RegExp(`^/api/titles/${title.id}/artwork\\?v=\\d+$`));
    const [art] = await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, title.id));
    expect(art).toMatchObject({ contentType: "image/jpeg", source: "embedded" });
    expect(Array.from(art.bytes)).toEqual(TEST_JPEG);
    expect(t.provider.fetchThumbnail).not.toHaveBeenCalled(); // it already has a picture
  });

  it("falls back to Box's thumbnail when the file has no cover, and keeps the filename-based name when it has no tags", async () => {
    const t = await setup([{ name: "plain clip.mp4", bytes: mp4WithTags() }]);
    t.thumbs.set(t.ids(0), Uint8Array.from(TEST_JPEG));
    await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    const [title] = Object.values(await t.byName());
    expect([title.name, title.nameSource, title.year]).toEqual(["plain clip", "filename", null]);
    const [art] = await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, title.id));
    expect(art.source).toBe("box");
    expect(title.posterUrl).toContain(`/api/titles/${title.id}/artwork`);
  });

  it("leaves the poster empty (never a broken URL) when Box has no thumbnail, and stops asking after the cap", async () => {
    const t = await setup([{ name: "nothumb.mp4", bytes: mp4WithTags() }]);
    for (let pass = 0; pass < MAX_TAG_ATTEMPTS + 2; pass++) await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    const [title] = Object.values(await t.byName());
    expect(title.posterUrl).toBeNull();
    expect(title.tagAttempts).toBe(MAX_TAG_ATTEMPTS);
    expect(t.provider.fetchThumbnail).toHaveBeenCalledTimes(MAX_TAG_ATTEMPTS);
    expect(await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, title.id))).toHaveLength(0);
  });

  it("retries a tag read that failed, up to the cap, without marking the title as read", async () => {
    const t = await setup([{ name: "flaky.mp4", bytes: null }]);
    const errors: string[] = [];
    for (let pass = 0; pass < MAX_TAG_ATTEMPTS + 2; pass++) await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), errors);
    const [title] = Object.values(await t.byName());
    expect(title.tagsAttemptedAt).toBeNull();
    expect(title.tagAttempts).toBe(MAX_TAG_ATTEMPTS);
    expect(errors).toHaveLength(MAX_TAG_ATTEMPTS);
    expect(t.provider.fetchByteRange.mock.calls.length).toBeGreaterThan(0);
  });

  it("skips files whose duration probe hasn't succeeded, and does nothing once the deadline has passed", async () => {
    const t = await setup([
      { name: "unprobed.mp4", bytes: mp4WithTags({ title: "Should Wait" }), probed: false },
      { name: "ready.mp4", bytes: mp4WithTags({ title: "Ready" }) },
    ]);
    expect(await readTagsAndArtwork(t.provider, t.lib.id, Date.now() - 1, [])).toBe(true); // out of time: reports work remaining
    expect(Object.keys(await t.byName()).sort()).toEqual(["ready", "unprobed"]); // untouched
    await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    expect(Object.keys(await t.byName()).sort()).toEqual(["Ready", "unprobed"]);
  });

  it("only touches the library it was asked about", async () => {
    const a = await setup([{ name: "a.mp4", bytes: mp4WithTags({ title: "A Tagged" }) }]);
    const b = await setup([{ name: "b.mp4", bytes: mp4WithTags({ title: "B Tagged" }) }]);
    await readTagsAndArtwork(a.provider, a.lib.id, farFuture(), []);
    expect(Object.keys(await a.byName())).toEqual(["A Tagged"]);
    expect(Object.keys(await b.byName())).toEqual(["b"]);
  });

  it("isn't re-read once done, and a rescan never undoes the embedded name", async () => {
    const t = await setup([{ name: "again.mp4", bytes: mp4WithTags({ title: "Stays Put" }) }]);
    await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    const reads = t.provider.fetchByteRange.mock.calls.length;
    await readTagsAndArtwork(t.provider, t.lib.id, farFuture(), []);
    expect(t.provider.fetchByteRange.mock.calls.length).toBe(reads);
    await syncVideoDirectory(t.lib.id, "p", "", [{ id: t.ids(0), name: "again.mp4", kind: "file", sizeBytes: 5 }]);
    expect(Object.keys(await t.byName())).toEqual(["Stays Put"]);
  });
});
