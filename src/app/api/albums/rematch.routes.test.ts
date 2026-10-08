/** POST /api/albums/[id]/rematch: only the server admin may ask, only while the library's look-up is on. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, admin: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => h.admin }));

import { libraries, musicAlbums, musicArtists } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./[id]/rematch/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.admin = null;
});

const post = (id: string) => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id }) } as never);

async function matchedAlbum() {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "A", nameKey: "a", sortKey: "a" }).returning();
  const [album] = await db
    .insert(musicAlbums)
    .values({ libraryId: lib.id, artistId: artist.id, name: "B", nameKey: "b", matchStatus: "unmatched", matchAttempts: 3, matchAttemptedAt: new Date(), matchedTrackCount: 4 })
    .returning();
  const row = async () => (await db.select().from(musicAlbums).where(eq(musicAlbums.id, album.id)))[0];
  return { lib, album, row };
}

describe("POST /api/albums/[id]/rematch", () => {
  it("is the same 404 for anyone but the server admin and for unknown or malformed ids, and changes nothing", async () => {
    const a = await matchedAlbum();
    for (const id of [a.album.id, "00000000-0000-4000-8000-0000000000aa", "nope"]) expect((await post(id)).status).toBe(404);
    expect(await a.row()).toMatchObject({ matchStatus: "unmatched", matchAttempts: 3 });
  });

  it("lets the admin queue a new look-up", async () => {
    const a = await matchedAlbum();
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await post(a.album.id)).status).toBe(200);
    expect(await a.row()).toMatchObject({ matchStatus: "pending", matchAttempts: 0, matchAttemptedAt: null, matchedTrackCount: null });
  });

  it("refuses while the library's look-up is switched off", async () => {
    const a = await matchedAlbum();
    await db.update(libraries).set({ musicLookup: false }).where(eq(libraries.id, a.lib.id));
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await post(a.album.id)).status).toBe(409);
    expect((await a.row()).matchStatus).toBe("unmatched");
  });
});
