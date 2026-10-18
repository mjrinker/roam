/** The quick look for new photos: it finds what was just added without listing the whole library. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: new Map<string, import("@/lib/storage/provider").StorageEntry[]>(),
  listed: [] as string[],
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
vi.mock("@/lib/scan/photo-meta", () => ({ readPhotoMetadata: vi.fn(async () => false) }));
vi.mock("@/lib/storage/server-storage", () => ({
  createStorageForServer: () => ({
    listFolder: async (id: string) => {
      h.listed.push(id);
      return h.tree.get(id) ?? [];
    },
    fetchByteRange: async () => new ArrayBuffer(0),
  }),
}));

import { titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { PHOTOS_PROFILE } from "./tree-profile";
import { syncVideoDirectory } from "./video-library";
import { scanRecentPhotos } from "./photos-recent";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const file = (id: string, name = `${id}.jpg`): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1000 });
const dir = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" });
const names = async (libraryId: string) => (await db.select({ k: titles.boxFolderId, path: titles.folderPath }).from(titles).where(eq(titles.libraryId, libraryId))).map((t) => `${t.path}|${t.k.replace("file:", "")}`).sort();

describe("scanning from the newest photo forward", () => {
  it("finds new photos in the newest folder, in a new folder beside it, and in a brand-new top folder, but not in an old folder", async () => {
    const admin = await makeAccount(db, "ra");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "photos", "everyone");
    const root = lib.boxFolderId;
    // The library as the last full scan left it.
    h.tree.set(root, [file("loose"), dir("y26", "2026")]);
    h.tree.set("y26", [dir("m07", "07"), dir("m08", "08"), dir("m09", "09"), dir("m10", "10")]);
    h.tree.set("m09", [file("old1"), file("old2")]);
    h.tree.set("m10", [dir("d17", "17")]);
    h.tree.set("d17", [file("a"), file("b")]);
    h.tree.set("m08", [file("older")]);
    h.tree.set("m07", [file("oldest")]);
    for (const [id, path, entries] of [["m09", "2026/09", [file("old1"), file("old2")]], ["m08", "2026/08", [file("older")]], ["m07", "2026/07", [file("oldest")]], [root, "", [file("loose")]], ["d17", "2026/10/17", [file("a"), file("b")]]] as const) {
      await syncVideoDirectory(lib.id, id, path, [...entries], null, PHOTOS_PROFILE);
      await new Promise((r) => setTimeout(r, 5)); // so the newest is clearly the last
    }
    expect(await names(lib.id)).toHaveLength(7);

    // Now: a photo more in the newest folder, a new day folder, a new top-level folder, and a photo added to an old month.
    h.tree.set("d17", [file("a"), file("b"), file("c")]);
    h.tree.set("m10", [dir("d17", "17"), dir("d18", "18")]);
    h.tree.set("d18", [file("n1"), file("n2")]);
    h.tree.set(root, [file("loose"), dir("y26", "2026"), dir("y27", "2027")]);
    h.tree.set("y27", [dir("j1", "01")]);
    h.tree.set("j1", [file("future")]);
    h.tree.set("m09", [file("old1"), file("old2"), file("sneaky")]);
    h.listed.length = 0;

    const result = await scanRecentPhotos(lib.id);
    expect(result).toMatchObject({ added: 4, incomplete: false });
    const all = await names(lib.id);
    expect(all).toEqual(expect.arrayContaining(["2026/10/17|c", "2026/10/18|n1", "2026/10/18|n2", "2027/01|future"]));
    expect(all.some((n) => n.endsWith("|sneaky"))).toBe(false); // an old folder is for the full scan
    // It listed the top, the way down to the newest folder, and the new folders: not the old month.
    expect(h.listed).not.toContain("m09");
    expect(new Set(h.listed).size).toBe(h.listed.length); // each folder at most once
    expect(h.listed).not.toContain("m08");
    expect(h.listed.length).toBeLessThanOrEqual(9); // not the whole library

    // A second look finds nothing new.
    expect((await scanRecentPhotos(lib.id)).added).toBe(0);
  });

  it("refuses a library that isn't photos", async () => {
    const admin = await makeAccount(db, "rb");
    const server = await makeServer(db, admin.accountId);
    const movies = await makeLibrary(db, server.id, "movies", "everyone");
    await expect(scanRecentPhotos(movies.id)).rejects.toThrow(/photo library/);
  });
});
