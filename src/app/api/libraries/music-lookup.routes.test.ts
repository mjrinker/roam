/** PUT /api/libraries/[id]/music-lookup: only the server admin may switch the MusicBrainz look-up, and only for music libraries. */
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
import { PUT } from "./[id]/music-lookup/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.admin = null;
});

const put = (id: string, body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) } as never);
const lookupOf = async (id: string) => (await db.select().from(libraries).where(eq(libraries.id, id)))[0].musicLookup;

describe("PUT /api/libraries/[id]/music-lookup", () => {
  it("is the same 404 for anyone but the server admin, and for unknown or malformed ids, and changes nothing", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const music = await makeLibrary(db, server.id, "music", "everyone");
    const responses = [await put(music.id, { enabled: false }), await put("00000000-0000-4000-8000-0000000000aa", { enabled: false }), await put("nope", { enabled: false })];
    for (const r of responses) expect(r.status).toBe(404);
    expect(await lookupOf(music.id)).toBe(true);
  });

  it("lets the admin switch it, validates the body, and refuses other kinds of library (including audio)", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const music = await makeLibrary(db, server.id, "music", "everyone");
    const movies = await makeLibrary(db, server.id, "audio", "everyone");
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await put(music.id, { enabled: false })).status).toBe(200);
    expect(await lookupOf(music.id)).toBe(false);
    expect((await put(music.id, { enabled: true })).status).toBe(200);
    expect(await lookupOf(music.id)).toBe(true);
    for (const bad of [{ enabled: "yes" }, {}, null]) expect((await put(music.id, bad)).status).toBe(400);
    expect((await put(movies.id, { enabled: false })).status).toBe(400);
    expect(await lookupOf(movies.id)).toBe(true);
  });
});
