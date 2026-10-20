/** Marking pictures as screenshots (or not): admin only, one server's photos only, and kept through later scans. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));

import { profiles, titles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { PUT } from "./route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }));
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
let n = 0;
const photo = (libraryId: string, kind: "photo" | "movie" = "photo") => makeTitle(db, libraryId, { kind, boxFolderId: `file:s${++n}` });
const flag = async (id: string) => (await db.select({ s: titles.isScreenshot, l: titles.screenshotLocked }).from(titles).where(eq(titles.id, id)))[0];

describe("PUT /api/photos/screenshots", () => {
  it("lets the server's admin mark and unmark pictures, locking the choice, and touches nothing else", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const other = await makeServer(db, (await makeAccount(db, "o2")).accountId);
    const lib = await makeLibrary(db, server.id, "photos", "everyone");
    const otherLib = await makeLibrary(db, other.id, "photos", "everyone");
    const videoLib = await makeLibrary(db, server.id, "video", "everyone");
    const a = await photo(lib.id), b = await photo(lib.id), movie = await photo(lib.id, "movie"), foreign = await photo(otherLib.id), notPhotos = await photo(videoLib.id);
    await signInAs(owner.accountId);

    const res = await put({ serverId: server.id, ids: [a.id, b.id, movie.id, foreign.id, notPhotos.id], screenshot: true });
    expect(await res.json()).toEqual({ changed: 2 });
    expect(await flag(a.id)).toEqual({ s: true, l: true });
    for (const t of [movie, foreign, notPhotos]) expect(await flag(t.id)).toEqual({ s: false, l: false });

    await put({ serverId: server.id, ids: [a.id], screenshot: false });
    expect(await flag(a.id)).toEqual({ s: false, l: true });
  });

  it("refuses everyone but the admin, and bad requests", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const member = await makeAccount(db, "m");
    await joinServer(db, server.id, member.accountId);
    const lib = await makeLibrary(db, server.id, "photos", "everyone");
    const t = await photo(lib.id);
    await signInAs(member.accountId);
    expect((await put({ serverId: server.id, ids: [t.id], screenshot: true })).status).toBe(404);
    expect(await flag(t.id)).toEqual({ s: false, l: false });
    h.resolution = null;
    expect((await put({ serverId: server.id, ids: [t.id], screenshot: true })).status).toBe(404);
    await signInAs(owner.accountId);
    expect((await put({ serverId: server.id, ids: [], screenshot: true })).status).toBe(400);
    expect((await put({ serverId: server.id, ids: ["nope"], screenshot: true })).status).toBe(400);
    expect((await put({ serverId: server.id, ids: [t.id] })).status).toBe(400);
  });
});
