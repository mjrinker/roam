/** A profile's choice to hide screenshots in Photos. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, viewers } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { PUT } from "./route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }));

describe("PUT /api/viewers/current/photos", () => {
  it("sets the choice for the signed-in profile only, refuses anything else, and needs a sign-in", async () => {
    const me = await makeAccount(db, "me");
    const other = await makeAccount(db, "other");
    const [account] = await db.select().from(profiles).where(eq(profiles.id, me.accountId));
    const mine = await db.select().from(viewers).where(eq(viewers.accountId, me.accountId));
    h.resolution = null;
    expect((await put({ hideScreenshots: true })).status).toBeGreaterThanOrEqual(401);
    h.resolution = { account, viewer: mine[0], viewers: mine };
    expect((await put({ hideScreenshots: true })).status).toBe(200);
    expect((await db.select().from(viewers).where(eq(viewers.id, mine[0].id)))[0].hideScreenshots).toBe(true);
    expect((await db.select().from(viewers).where(eq(viewers.accountId, other.accountId)))[0].hideScreenshots).toBe(false);
    expect((await put({ hideScreenshots: "yes" })).status).toBe(400);
    expect((await put({ hideScreenshots: false, extra: 1 })).status).toBe(400);
    expect((await put({ hideScreenshots: false })).status).toBe(200);
    expect((await db.select().from(viewers).where(eq(viewers.id, mine[0].id)))[0].hideScreenshots).toBe(false);
  });
});
