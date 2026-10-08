/** The demo's play limits against the REAL rate limiter and its table (a daily total for the whole demo, plus a per-account hourly limit). */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { makeAccount, makeServer } from "@/lib/playlists/test-db";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { checkDemoPlay, DEMO_RESTING_MESSAGE, secondsUntilWindowRenews } from "./demo-limits";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function world(demo: boolean) {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  if (demo) await db.update(servers).set({ isDemo: true }).where(eq(servers.id, server.id));
  return { owner, server };
}

describe("secondsUntilWindowRenews", () => {
  it("counts down to the next UTC midnight, which is when the daily window starts over", () => {
    expect(secondsUntilWindowRenews(new Date("2026-10-07T00:00:00Z"))).toBe(86_400);
    expect(secondsUntilWindowRenews(new Date("2026-10-07T23:59:59Z"))).toBe(1);
    expect(secondsUntilWindowRenews(new Date("2026-10-07T12:00:00Z"))).toBe(43_200);
  });
});

describe("checkDemoPlay", () => {
  it("never limits, or even counts, a server that isn't a demo", async () => {
    const { server, owner } = await world(false);
    for (let i = 0; i < 50; i++) expect(await checkDemoPlay(server.id, owner.accountId, { perDay: 1, perAccountPerHour: 1 })).toEqual({ ok: true });
  });

  it("allows plays up to the daily total across ALL accounts, then rests, with the demo's own message", async () => {
    const { server } = await world(true);
    const guests = [await makeAccount(db, "g1"), await makeAccount(db, "g2"), await makeAccount(db, "g3")];
    const limits = { perDay: 5, perAccountPerHour: 100 };
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) results.push((await checkDemoPlay(server.id, guests[i % 3].accountId, limits)).ok);
    expect(results).toEqual([true, true, true, true, true, false, false]);
    expect(await checkDemoPlay(server.id, guests[0].accountId, limits)).toEqual({ ok: false, error: DEMO_RESTING_MESSAGE });
  });

  it("limits one account per hour without using up everyone else's share", async () => {
    const { server } = await world(true);
    const busy = await makeAccount(db, "busy");
    const other = await makeAccount(db, "other");
    const limits = { perDay: 1000, perAccountPerHour: 3 };
    const mine = [];
    for (let i = 0; i < 5; i++) mine.push((await checkDemoPlay(server.id, busy.accountId, limits)).ok);
    expect(mine).toEqual([true, true, true, false, false]);
    expect(await checkDemoPlay(server.id, other.accountId, limits)).toEqual({ ok: true });
  });

  it("keeps each demo's total separate, and a missing server is simply allowed (the caller already authorised it)", async () => {
    const a = await world(true);
    const b = await world(true);
    const viewer = await makeAccount(db, "v");
    expect((await checkDemoPlay(a.server.id, viewer.accountId, { perDay: 1 })).ok).toBe(true);
    expect((await checkDemoPlay(a.server.id, viewer.accountId, { perDay: 1 })).ok).toBe(false);
    expect((await checkDemoPlay(b.server.id, viewer.accountId, { perDay: 1 })).ok).toBe(true);
    expect(await checkDemoPlay(crypto.randomUUID(), viewer.accountId)).toEqual({ ok: true });
  });
});
