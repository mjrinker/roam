/** Pairing a TV: codes, expiry, single use, limits. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { tvPairings } from "@/lib/db/schema";
import { createTestDb, makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { CODE_ALPHABET, CODE_LENGTH, MAX_PENDING, MAX_STARTS_PER_ADDRESS_PER_HOUR, PAIRING_TTL_MS, approvePairing, deviceLabel, findOpenPairing, formatUserCode, generateUserCode, hashSecret, normalizeUserCode, openPairingCount, pollPairing, startPairing } from "./pairing";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

let n = 0;
const ip = () => `10.0.${Math.floor(++n / 250)}.${n % 250}`;

describe("codes", () => {
  it("are five characters from an alphabet without look-alikes", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(CODE_LENGTH).toBe(5);
    expect(formatUserCode("ABCDE")).toBe("ABCDE");
  });
  it("use every symbol of the alphabet (the choice is spread over all of it)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const c of generateUserCode()) seen.add(c);
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });
  it("are read back forgivingly and strictly", () => {
    // upper case, lower case and mixed all mean the same code; spaces and hyphens are ignored
    for (const typed of ["abcde", "ABCDE", "AbCdE", " ab cde ", "ab-cde", "A-B-C-D-E"]) expect(normalizeUserCode(typed), typed).toBe("ABCDE");
    for (const bad of ["", null, undefined, "ABCD", "ABCDEF", "ABC-D0", "ABCIE", "ABC_E", "'; drop table", "ABCDEFGH"]) expect(normalizeUserCode(bad as never), String(bad)).toBeNull();
  });
  it("names a TV from its browser", () => {
    expect(deviceLabel("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36")).toBe("Samsung TV");
    expect(deviceLabel("Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/87")).toBe("LG TV");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 9; AFTMM) Silk/100")).toBe("Fire TV");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux) VIZIO SmartCast")).toBe("Vizio TV");
    expect(deviceLabel(null)).toBe("TV");
  });
});

describe("pairing", () => {
  const start = async (over: { ip?: string; now?: Date } = {}) => {
    const r = await startPairing(db, { ip: over.ip ?? ip(), userAgent: "Tizen", now: over.now });
    if (!r.ok) throw new Error(r.reason);
    return r;
  };

  it("hands a TV a code and a secret, stores only the secret's hash, and shows pending until approved", async () => {
    const r = await start();
    const [row] = await db.select().from(tvPairings).where(eq(tvPairings.userCode, r.userCode));
    expect(row).toMatchObject({ status: "pending", deviceLabel: "Samsung TV", accountId: null });
    expect(row.deviceHash).toBe(hashSecret(r.secret));
    expect(JSON.stringify(row)).not.toContain(r.secret);
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(PAIRING_TTL_MS - 5000);
    expect(await pollPairing(db, r.secret)).toEqual({ status: "pending" });
  });

  it("gives the account to the TV exactly once after approval", async () => {
    const who = await makeAccount(db, "pairer");
    const r = await start();
    expect(await approvePairing(db, { userCode: r.userCode, accountId: who.accountId })).toBe(true);
    expect(await pollPairing(db, r.secret)).toEqual({ status: "approved", accountId: who.accountId });
    expect(await pollPairing(db, r.secret)).toEqual({ status: "expired" }); // already taken
    expect(await approvePairing(db, { userCode: r.userCode, accountId: who.accountId })).toBe(false); // and no longer open
  });

  it("two TVs polling at once cannot both receive the session", async () => {
    const who = await makeAccount(db, "racer");
    const r = await start();
    await approvePairing(db, { userCode: r.userCode, accountId: who.accountId });
    const results = await Promise.all([pollPairing(db, r.secret), pollPairing(db, r.secret), pollPairing(db, r.secret)]);
    expect(results.filter((x) => x.status === "approved")).toHaveLength(1);
  });

  it("does not know a secret it never issued, or a code that was never open", async () => {
    expect(await pollPairing(db, "not-a-secret")).toEqual({ status: "expired" });
    const who = await makeAccount(db, "guesser");
    expect(await approvePairing(db, { userCode: "ABCDE", accountId: who.accountId })).toBe(false);
    expect(await findOpenPairing(db, "ABCDE")).toBeNull();
  });

  it("lets a code lapse after ten minutes: it can't be approved and the TV is told", async () => {
    const who = await makeAccount(db, "late");
    const t0 = new Date();
    const r = await start({ now: t0 });
    const later = new Date(t0.getTime() + PAIRING_TTL_MS + 1000);
    expect(await findOpenPairing(db, r.userCode, later)).toBeNull();
    expect(await approvePairing(db, { userCode: r.userCode, accountId: who.accountId, now: later })).toBe(false);
    expect(await pollPairing(db, r.secret, later)).toEqual({ status: "expired" });
  });

  it("does not hand over a session that was approved but not collected in time", async () => {
    const who = await makeAccount(db, "slow");
    const t0 = new Date();
    const r = await start({ now: t0 });
    await approvePairing(db, { userCode: r.userCode, accountId: who.accountId, now: t0 });
    expect(await pollPairing(db, r.secret, new Date(t0.getTime() + PAIRING_TTL_MS + 1000))).toEqual({ status: "expired" });
  });

  it("describes an open pairing so the approver can see what they are approving", async () => {
    const r = await start();
    expect(await findOpenPairing(db, r.userCode)).toMatchObject({ deviceLabel: "Samsung TV" });
  });

  it("limits how many codes one address can ask for in an hour, but not other addresses", async () => {
    const busy = ip();
    for (let i = 0; i < MAX_STARTS_PER_ADDRESS_PER_HOUR; i++) await start({ ip: busy });
    expect(await startPairing(db, { ip: busy, userAgent: null })).toEqual({ ok: false, reason: "too_many" });
    expect((await startPairing(db, { ip: ip(), userAgent: null })).ok).toBe(true);
    const nextHour = new Date(Date.now() + 61 * 60 * 1000);
    expect((await startPairing(db, { ip: busy, userAgent: null, now: nextHour })).ok).toBe(true);
  });

  it("recycles a code once its row has been swept, and re-draws when a pick lands on a code still held", async () => {
    // A rigged random source that always spells the same code: "ABCDE" (the first five symbols of the alphabet).
    const rigged = () => { let i = 0; return (_max: number) => i++ % 5; };

    // First TV gets ABCDE, three hours ago.
    const t0 = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const first = await startPairing(db, { ip: ip(), userAgent: null, now: t0, rand: rigged() });
    expect(first.ok && first.userCode).toBe("ABCDE");

    // Today the old row is long dead, so the very same code is handed out again.
    const again = await startPairing(db, { ip: ip(), userAgent: null, rand: rigged() });
    expect(again.ok && again.userCode).toBe("ABCDE");
    expect(await db.select().from(tvPairings).where(eq(tvPairings.userCode, "ABCDE"))).toHaveLength(1);

    // While that one is live, a draw that lands on it is refused and re-drawn, so a new TV gets a different code...
    let calls = 0;
    const collideThenFree = (_max: number) => (calls++ < 5 ? calls - 1 : 20 + (calls % 5)); // first five draws spell ABCDE, then something else
    const other = await startPairing(db, { ip: ip(), userAgent: null, rand: collideThenFree });
    expect(other.ok).toBe(true);
    expect(other.ok && other.userCode).not.toBe("ABCDE");

    // ...and if every draw collides, it gives up politely instead of looping.
    const stuck = await startPairing(db, { ip: ip(), userAgent: null, rand: rigged() });
    expect(stuck).toEqual({ ok: false, reason: "busy" });
  });

  it("stores the address only as a keyed hash", async () => {
    const address = "203.0.113.77";
    await start({ ip: address });
    const rows = await db.select().from(tvPairings);
    expect(JSON.stringify(rows)).not.toContain(address);
  });

  it("removes rows that have been dead for an hour when the next code is asked for, and keeps live ones", async () => {
    const t0 = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const old = await start({ now: t0 });
    const fresh = await start({ now: new Date(t0.getTime() + 60_000) }); // a start in the same era sweeps nothing of it
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, old.userCode))).length).toBe(1);
    const live = await start(); // now, hours later: the old rows are long dead
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, old.userCode))).length).toBe(0);
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, fresh.userCode))).length).toBe(0);
    expect((await db.select().from(tvPairings).where(eq(tvPairings.userCode, live.userCode))).length).toBe(1);
  });

  it("says it is busy rather than growing without bound", async () => {
    expect(MAX_PENDING).toBeGreaterThan(100);
    expect(await openPairingCount(db)).toBeGreaterThan(0);
  });
});
