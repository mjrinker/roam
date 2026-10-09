/** PUT /api/libraries/[id]/my-playback-speed: a profile's own starting speed for a library, 0.25 to 3, seen by that profile only. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, viewerLibrarySpeeds, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { viewerLibrarySpeed } from "@/lib/player/library-speed";
import { PUT } from "./[id]/my-playback-speed/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  return all[0].id;
}
const put = (id: string, body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) } as never);

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const a = await makeAccount(db, "a");
  const b = await makeAccount(db, "b");
  await joinServer(db, server.id, a.accountId);
  await joinServer(db, server.id, b.accountId);
  const mk = (kind: Parameters<typeof makeLibrary>[2], access: "everyone" | "restricted" = "everyone") => makeLibrary(db, server.id, kind, access);
  return { a, b, mk, movies: await mk("movies"), ebooks: await mk("ebooks"), music: await mk("music") };
}

describe("PUT /api/libraries/[id]/my-playback-speed", () => {
  it("has no starting speed until a profile sets one", async () => {
    const w = await world();
    const a = await signInAs(w.a.accountId);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBeNull();
  });
  it("saves a profile's speed, replaces it, and clears it; each library separately", async () => {
    const w = await world();
    const a = await signInAs(w.a.accountId);
    expect((await put(w.movies.id, { speed: 1.25 })).status).toBe(200);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBe(1.25);
    expect((await put(w.movies.id, { speed: 3 })).status).toBe(200);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBe(3);
    expect((await put(w.music.id, { speed: 0.25 })).status).toBe(200);
    expect(await viewerLibrarySpeed(a, w.music.id)).toBe(0.25);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBe(3);
    expect((await put(w.movies.id, { speed: null })).status).toBe(200);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBeNull();
    expect(await db.select().from(viewerLibrarySpeeds).where(and(eq(viewerLibrarySpeeds.viewerId, a), eq(viewerLibrarySpeeds.libraryId, w.movies.id)))).toEqual([]);
  });
  it("applies to that profile only", async () => {
    const w = await world();
    const a = await signInAs(w.a.accountId);
    await put(w.movies.id, { speed: 2 });
    const b = await signInAs(w.b.accountId);
    expect(await viewerLibrarySpeed(b, w.movies.id)).toBeNull();
    await put(w.movies.id, { speed: 1.5 });
    expect(await viewerLibrarySpeed(b, w.movies.id)).toBe(1.5);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBe(2);
  });
  it("is the same 404 for a library the profile can't see, one on another server, and unknown or malformed ids", async () => {
    const w = await world();
    const a = await signInAs(w.a.accountId);
    const hidden = await w.mk("movies", "restricted");
    const other = await world();
    for (const id of [hidden.id, other.movies.id, "00000000-0000-4000-8000-0000000000aa", "nope"]) expect((await put(id, { speed: 1.5 })).status, id).toBe(404);
    expect(await db.select().from(viewerLibrarySpeeds).where(eq(viewerLibrarySpeeds.viewerId, a))).toEqual([]);
  });
  it("refuses a speed outside 0.25 to 3, a missing or non-numeric one, and an eBook library", async () => {
    const w = await world();
    const a = await signInAs(w.a.accountId);
    await put(w.movies.id, { speed: 2 });
    for (const bad of [{ speed: 0.2 }, { speed: 3.5 }, { speed: 0 }, { speed: -1 }, { speed: "2" }, {}, null]) expect((await put(w.movies.id, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await viewerLibrarySpeed(a, w.movies.id)).toBe(2);
    expect((await put(w.ebooks.id, { speed: 1.5 })).status).toBe(400);
    expect(await viewerLibrarySpeed(a, w.ebooks.id)).toBeNull();
  });
});
