/** The per-server photo budget against the REAL rate limiter and its table (the route tests stub the limiter). */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({ createBoxProviderForServer: () => ({}) }));

import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { rateLimitBuckets } from "@/lib/db/schema";
import { SERVER_BOX_CALLS_PER_MINUTE, spendServerBudget } from "./serve";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

describe("spendServerBudget", () => {
  it("records against the server's owner without violating the table's foreign key, counting per server", async () => {
    const owner = await makeAccount(db, "o");
    const a = await makeServer(db, owner.accountId);
    const b = await makeServer(db, owner.accountId);
    for (let i = 0; i < 3; i++) expect(await spendServerBudget(a.id)).toBe(true);
    expect(await spendServerBudget(b.id)).toBe(true);
    const rows = await db.select().from(rateLimitBuckets);
    expect(rows.map((r) => [r.bucket, r.count]).sort()).toEqual([[`photo_box:${a.id}`, 3], [`photo_box:${b.id}`, 1]].sort());
  });

  it("refuses once the server is over its budget, and for a server that doesn't exist", async () => {
    const owner = await makeAccount(db, "o2");
    const s = await makeServer(db, owner.accountId);
    for (let i = 0; i < SERVER_BOX_CALLS_PER_MINUTE; i++) await spendServerBudget(s.id);
    expect(await spendServerBudget(s.id)).toBe(false);
    expect(await spendServerBudget("00000000-0000-4000-8000-0000000000ff")).toBe(false);
  });
});
