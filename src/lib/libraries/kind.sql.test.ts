/** Video-library detection, and a guard that every TMDB/Audible/folder-based admin route refuses video titles. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isVideoLibraryKind, libraryKindOfTitle } from "./kind";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("libraryKindOfTitle", () => {
  it("returns the kind of the title's library, or null for an unknown title", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const movies = await makeLibrary(db, server.id, "movies", "everyone");
    const video = await makeLibrary(db, server.id, "video", "everyone");
    const a = await makeTitle(db, movies.id);
    const b = await makeTitle(db, video.id, { boxFolderId: "file:1" });
    expect(await libraryKindOfTitle(db, a.id)).toBe("movies");
    expect(await libraryKindOfTitle(db, b.id)).toBe("video");
    expect(await libraryKindOfTitle(db, "00000000-0000-4000-8000-000000000abc")).toBeNull();
    expect(isVideoLibraryKind("video")).toBe(true);
    expect(isVideoLibraryKind("movies")).toBe(false);
    expect(isVideoLibraryKind(null)).toBe(false);
  });
});

describe("admin title routes refuse video-library titles", () => {
  // These routes assume a TMDB/Audible match or that box_folder_id is a real Box folder; a video
  // title's box_folder_id is a file key, so acting on it would call Box with a bogus folder id.
  for (const route of ["match", "match-audible", "sync", "fix-audio"]) {
    it(`api/titles/[id]/${route}`, () => {
      const source = readFileSync(path.join(__dirname, `../../app/api/titles/[id]/${route}/route.ts`), "utf8");
      expect(source).toContain("isVideoLibraryKind(await libraryKindOfTitle(db, id))");
      // The guard runs after the admin check, so non-admins still can't probe library kinds.
      expect(source.indexOf("getCurrentServerAdmin(serverId)")).toBeLessThan(source.indexOf("isVideoLibraryKind("));
    });
  }
});
