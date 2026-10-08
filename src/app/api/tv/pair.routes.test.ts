/** POST /api/tv/pair: approving a TV's code from a signed-in device. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, account: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({ getCurrentProfile: async () => h.account }));

import { profiles, tvPairings } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { startPairing } from "@/lib/tv/pairing";
import { POST } from "./pair/route";

let db: TestDb;
beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = h.testDb.db;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  h.account = null;
});

const post = (body: unknown) => POST(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
let n = 0;
const open = async () => {
  const r = await startPairing(db, { ip: `192.0.2.${++n % 250}`, userAgent: "Mozilla/5.0 (SMART-TV; Tizen 5.5)" });
  if (!r.ok) throw new Error(r.reason);
  return r;
};
async function signIn(label: string) {
  const who = await makeAccount(db, label);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  h.account = account;
  return account;
}

describe("POST /api/tv/pair", () => {
  it("needs a signed-in account, and not a guest", async () => {
    const r = await open();
    expect((await post({ code: r.userCode })).status).toBe(401);
    const account = await signIn("g");
    h.account = { ...account, isGuest: true };
    expect((await post({ code: r.userCode })).status).toBe(403);
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, r.userCode)))[0].status).toBe("pending");
  });

  it("shows which TV a code belongs to without approving it, then approves it on confirmation", async () => {
    const account = await signIn("a");
    const r = await startPairing(db, { ip: "192.0.2.250", userAgent: "Mozilla/5.0 (SMART-TV; Tizen 5.5)", location: "Denver, US" });
    if (!r.ok) throw new Error(r.reason);
    const look = await post({ code: r.userCode.toLowerCase() });
    expect(look.status).toBe(200);
    expect(await look.json()).toMatchObject({ deviceLabel: "Samsung TV", location: "Denver, US" });
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, r.userCode)))[0]).toMatchObject({ status: "pending", accountId: null });
    const ok = await post({ code: `${r.userCode.slice(0, 4)}-${r.userCode.slice(4)}`, approve: true });
    expect([ok.status, (await ok.json()).ok]).toEqual([200, true]);
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, r.userCode)))[0]).toMatchObject({ status: "approved", accountId: account.id });
  });

  it("answers a wrong, malformed, expired or already-approved code in the same way", async () => {
    await signIn("b");
    const used = await open();
    await post({ code: used.userCode, approve: true });
    const expired = await open();
    await db.update(tvPairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tvPairings.userCode, expired.userCode));
    const answers = [];
    for (const code of ["ABCDEFGH", "nope", "", used.userCode, expired.userCode]) {
      const res = await post({ code, approve: true });
      answers.push([res.status, JSON.stringify(await res.json())]);
    }
    expect(new Set(answers.map((a) => a.join("|"))).size).toBe(1);
    expect(answers[0][0]).toBe(404);
  });

  it("rejects a malformed request", async () => {
    await signIn("c");
    expect((await post({})).status).toBe(400);
    expect((await post({ code: 5 })).status).toBe(400);
    expect((await post({ code: "x".repeat(100) })).status).toBe(400);
  });

  it("limits tries per account, so a code can't be guessed", async () => {
    await signIn("d");
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await post({ code: "ABCDEFGH" })).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    const other = await signIn("e"); // another account has its own allowance
    expect(other).toBeTruthy();
    expect((await post({ code: "ABCDEFGH" })).status).toBe(404);
  });
});
