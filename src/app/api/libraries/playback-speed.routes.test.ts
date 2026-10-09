/** PUT /api/libraries/[id]/playback-speed: only the server admin may set a library's default speed, within 0.25 to 3. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, admin: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => h.admin }));

import { libraries } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { PUT } from "./[id]/playback-speed/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.admin = null;
});

const put = (id: string, body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) } as never);
const speedOf = async (id: string) => (await db.select().from(libraries).where(eq(libraries.id, id)))[0].defaultPlaybackSpeed;

async function setup() {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  return { server, movies: await makeLibrary(db, server.id, "movies", "everyone"), ebooks: await makeLibrary(db, server.id, "ebooks", "everyone"), music: await makeLibrary(db, server.id, "music", "everyone") };
}

describe("PUT /api/libraries/[id]/playback-speed", () => {
  it("starts with no default (normal speed)", async () => {
    const w = await setup();
    expect(await speedOf(w.movies.id)).toBeNull();
  });
  it("is the same 404 for anyone but the server admin, and for unknown or malformed ids, and changes nothing", async () => {
    const w = await setup();
    for (const r of [await put(w.movies.id, { speed: 1.5 }), await put("00000000-0000-4000-8000-0000000000aa", { speed: 1.5 }), await put("nope", { speed: 1.5 })]) expect(r.status).toBe(404);
    expect(await speedOf(w.movies.id)).toBeNull();
  });
  it("lets the admin set a speed and clear it again, for any library that plays", async () => {
    const w = await setup();
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await put(w.movies.id, { speed: 1.25 })).status).toBe(200);
    expect(await speedOf(w.movies.id)).toBe(1.25);
    expect((await put(w.music.id, { speed: 0.25 })).status).toBe(200);
    expect(await speedOf(w.music.id)).toBe(0.25);
    expect((await put(w.movies.id, { speed: 3 })).status).toBe(200);
    expect(await speedOf(w.movies.id)).toBe(3);
    expect((await put(w.movies.id, { speed: null })).status).toBe(200);
    expect(await speedOf(w.movies.id)).toBeNull();
  });
  it("refuses a speed outside 0.25 to 3, a missing or non-numeric one, and an eBook library", async () => {
    const w = await setup();
    h.admin = { profile: { id: "x" }, role: "admin" };
    await put(w.movies.id, { speed: 2 });
    for (const bad of [{ speed: 0.2 }, { speed: 3.5 }, { speed: 0 }, { speed: -1 }, { speed: "2" }, {}, null]) expect((await put(w.movies.id, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await speedOf(w.movies.id)).toBe(2);
    expect((await put(w.ebooks.id, { speed: 1.5 })).status).toBe(400);
    expect(await speedOf(w.ebooks.id)).toBeNull();
  });
});
