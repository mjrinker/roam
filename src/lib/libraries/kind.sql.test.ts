/** Which libraries use outside metadata services, and the guard that keeps every other kind away from them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { libraryKindOfTitle, NOT_FOR_THIS_LIBRARY, refuseUnlessExternalMetadata } from "./kind";
import { FILE_TREE_KINDS, EXTERNAL_METADATA_KINDS, isFileTreeLibraryKind, libraryKindUsesExternalMetadata } from "./profile";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("library kind families", () => {
  it("are explicit, disjoint lists: a kind in neither is treated as neither", () => {
    for (const kind of EXTERNAL_METADATA_KINDS) {
      expect(libraryKindUsesExternalMetadata(kind)).toBe(true);
      expect(isFileTreeLibraryKind(kind)).toBe(false);
    }
    for (const kind of FILE_TREE_KINDS) {
      expect(libraryKindUsesExternalMetadata(kind)).toBe(false);
      expect(isFileTreeLibraryKind(kind)).toBe(true);
    }
    // Unknown, missing or future kinds are in neither family.
    for (const kind of [null, undefined, "podcasts", "ebooks"] as never[]) {
      expect(libraryKindUsesExternalMetadata(kind), String(kind)).toBe(false);
      expect(isFileTreeLibraryKind(kind), String(kind)).toBe(false);
    }
  });
});

describe("libraryKindOfTitle / refuseUnlessExternalMetadata", () => {
  it("lets titles of externally matched libraries through and refuses every other kind, and missing titles", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const outcomes: Record<string, number | null> = {};
    for (const kind of ["movies", "shows", "audiobooks", "video", "audio"] as const) {
      const lib = await makeLibrary(db, server.id, kind, "everyone");
      const title = await makeTitle(db, lib.id, { boxFolderId: `${kind}-${Math.random()}` });
      expect(await libraryKindOfTitle(db, title.id)).toBe(kind);
      outcomes[kind] = (await refuseUnlessExternalMetadata(db, title.id))?.status ?? null;
    }
    expect(outcomes).toEqual({ movies: null, shows: null, audiobooks: null, video: 400, audio: 400 });
    const missing = await refuseUnlessExternalMetadata(db, "00000000-0000-4000-8000-0000000000aa");
    expect(missing?.status).toBe(404);
    expect(await libraryKindOfTitle(db, "00000000-0000-4000-8000-0000000000aa")).toBeNull();
    expect(NOT_FOR_THIS_LIBRARY.length).toBeGreaterThan(0);
  });
});
