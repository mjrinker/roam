/** The photo edits file is the admin's: anyone else gets a plain not-found. */
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

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { GET as exportRoute } from "./photos/route";
import { POST as importRoute } from "../import/photos/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}

describe("photo edits export and import routes", () => {
  it("serve the admin and nobody else", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const member = await makeAccount(db, "m");
    await joinServer(db, server.id, member.accountId);
    const url = `http://x?serverId=${server.id}`;
    await signInAs(member.accountId);
    expect((await exportRoute(new Request(url))).status).toBe(404);
    expect((await importRoute(new Request(url, { method: "POST", body: "{}" }))).status).toBe(404);
    await signInAs(owner.accountId);
    const ok = await exportRoute(new Request(url));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("roam-photos-");
    const body = await ok.json();
    expect(body).toMatchObject({ format: "roam-photo-edits", people: [], tags: [] });
    expect((await importRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }))).status).toBe(200);
    expect((await importRoute(new Request(url, { method: "POST", body: "nope" }))).status).toBe(400);
    expect((await exportRoute(new Request("http://x?serverId=nope"))).status).toBe(404);
  });
});
