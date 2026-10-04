/** PUT /api/libraries/[id]/prune: only the server admin may switch cleanup on or off, and only for video libraries. */
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
import { PUT } from "./[id]/prune/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.admin = null;
});

const put = (id: string, body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) } as never);
const pruneOf = async (id: string) => (await db.select().from(libraries).where(eq(libraries.id, id)))[0].pruneMissing;

describe("PUT /api/libraries/[id]/prune", () => {
  it("is the same 404 for anyone but the server admin, and for unknown or malformed ids, and changes nothing", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const video = await makeLibrary(db, server.id, "video", "everyone");
    const responses = [await put(video.id, { enabled: false }), await put("00000000-0000-4000-8000-0000000000aa", { enabled: false }), await put("nope", { enabled: false })];
    for (const r of responses) expect(r.status).toBe(404);
    expect(await pruneOf(video.id)).toBe(true);
  });

  it("lets the admin switch it, validates the body, and refuses other kinds of library", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const video = await makeLibrary(db, server.id, "video", "everyone");
    const movies = await makeLibrary(db, server.id, "movies", "everyone");
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await put(video.id, { enabled: false })).status).toBe(200);
    expect(await pruneOf(video.id)).toBe(false);
    expect((await put(video.id, { enabled: true })).status).toBe(200);
    expect(await pruneOf(video.id)).toBe(true);
    for (const bad of [{ enabled: "yes" }, {}, null]) expect((await put(video.id, bad)).status).toBe(400);
    expect((await put(movies.id, { enabled: false })).status).toBe(400);
    expect(await pruneOf(movies.id)).toBe(true);
  });
});
