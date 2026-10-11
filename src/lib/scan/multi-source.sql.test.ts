/** A library made of several folders, on different storage connections, is scanned as one library. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: new Map<string, import("@/lib/storage/provider").StorageEntry[] | Error>(),
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
vi.mock("@/lib/storage/server-storage", () => ({
  createStorageForServer: () => ({
    listFolder: async (id: string) => {
      const l = h.tree.get(id);
      if (l instanceof Error) throw l;
      if (!l) throw new Error(`no such folder ${id}`);
      return l;
    },
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }),
    fetchByteRange: async () => new ArrayBuffer(0),
  }),
}));

import { librarySources, libraries, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { scanLibrary } from "./scanner";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const file = (id: string, name: string): StorageEntry => ({ id, name, kind: "file", sizeBytes: 5_000_000 }) as StorageEntry;
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" }) as StorageEntry;
const CONN = "cn_33333333-3333-4333-8333-333333333333:";

async function setup() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "video", "everyone");
  const nonce = Math.random().toString(36).slice(2, 8);
  const rootA = `A${nonce}`;
  const rootB = `${CONN}B${nonce}`;
  await db.update(libraries).set({ boxFolderId: rootA }).where(eq(libraries.id, lib.id));
  await db.insert(librarySources).values({ libraryId: lib.id, rootId: rootB, label: "Second place", position: 0 });
  return { lib, rootA, rootB, nonce };
}
const titleNames = async (libraryId: string) => (await db.select({ name: titles.name, path: titles.folderPath }).from(titles).where(eq(titles.libraryId, libraryId))).map((t) => `${t.path ?? ""}/${t.name}`).sort();

describe("a library made of several folders", () => {
  it("finds what is in each folder, on any connection, and merges folders of the same name", async () => {
    const s = await setup();
    h.tree.set(s.rootA, [file(`la${s.nonce}`, "loose a.mp4"), folder(`fa${s.nonce}`, "Holiday")]);
    h.tree.set(`fa${s.nonce}`, [file(`a1${s.nonce}`, "beach.mp4")]);
    h.tree.set(s.rootB, [file(`${CONN}lb${s.nonce}`, "loose b.mp4"), folder(`${CONN}fb${s.nonce}`, "Holiday")]);
    h.tree.set(`${CONN}fb${s.nonce}`, [file(`${CONN}b1${s.nonce}`, "mountain.mp4")]);
    const result = await scanLibrary(s.lib.id, "manual");
    expect(result.errors).toEqual([]);
    expect(await titleNames(s.lib.id)).toEqual(["/loose a", "/loose b", "Holiday/beach", "Holiday/mountain"]);
  });

  it("still scans the other folders when one can't be read, and reports it", async () => {
    const s = await setup();
    h.tree.set(s.rootA, [file(`la${s.nonce}`, "only a.mp4")]);
    h.tree.set(s.rootB, new Error("Dropbox is signed out"));
    const result = await scanLibrary(s.lib.id, "manual");
    expect(result.errors.join(" ")).toContain("Second place: Dropbox is signed out");
    expect(await titleNames(s.lib.id)).toEqual(["/only a"]);
  });

  it("fails as before for a library with a single folder that can't be read", async () => {
    const owner = await makeAccount(db, "o2");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    const root = `solo${Math.random().toString(36).slice(2, 8)}`;
    await db.update(libraries).set({ boxFolderId: root }).where(eq(libraries.id, lib.id));
    h.tree.set(root, new Error("folder gone"));
    const result = await scanLibrary(lib.id, "manual");
    expect(result.errors.join(" ")).toContain("folder gone");
  });
});
