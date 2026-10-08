/** The TV's sign-in screen and its polling: one code per TV, a session only after approval, and only once. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  signedIn: false,
  jar: new Map<string, string>(),
  minted: [] as string[],
  mintOk: true,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (arg: string | { name: string }) => void h.jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
}));
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => (h.signedIn ? { account: {}, viewer: {}, viewers: [] } : null) }));
vi.mock("@/lib/tv/session", () => ({ mintTvSession: async (id: string) => (h.minted.push(id), h.mintOk ? { ok: true } : { ok: false, reason: "failed" }) }));

import { tvPairings } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { approvePairing } from "@/lib/tv/pairing";
import { TV_PAIR_COOKIE } from "@/lib/tv/http";
import { GET } from "./pair/route";
import { POST } from "./pair/poll/route";

let db: TestDb;
beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = h.testDb.db;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  h.signedIn = false;
  h.jar.clear();
  h.minted.length = 0;
  h.mintOk = true;
});

let n = 0;
const getPage = (ip = `198.51.100.${++n % 250}`, extra: Record<string, string> = {}) => GET(new Request("https://roam.example/tv/pair", { headers: { "x-vercel-forwarded-for": ip, "user-agent": "Mozilla/5.0 (SMART-TV; Tizen 4.0)", ...extra } }));
const code = (body: string) => /class="code">([A-Z0-9]{4}-[A-Z0-9]{4})</.exec(body)?.[1] ?? "";

describe("GET /tv/pair", () => {
  it("shows a code and where to enter it, and remembers the TV with a cookie it alone holds", async () => {
    const res = await getPage();
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(code(body)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body).toContain("roam.example/link");
    expect(body).toMatch(/<svg class="qr"/); // a QR code the phone's camera can scan
    expect(body).not.toContain("width=\""); // sized by CSS, not fixed pixels
    expect(body).toContain("Scan with your phone");
    expect(body).toContain('data-poll="/tv/pair/poll"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.jar.get(TV_PAIR_COOKIE)).toBeTruthy();
    expect(body).not.toContain(h.jar.get(TV_PAIR_COOKIE)!); // the secret never reaches the page
  });
  it("records roughly where the TV asked from, for whoever approves it, and counts addresses by the platform's header", async () => {
    await getPage("203.0.113.9", { "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country": "BR" });
    const [row] = await db.select().from(tvPairings).where(eq(tvPairings.status, "pending")).orderBy(tvPairings.createdAt);
    expect(row).toBeTruthy();
    const rows = await db.select().from(tvPairings);
    expect(rows.some((r) => r.locationHint === "São Paulo, BR")).toBe(true);
    // a visitor can't pick their own address with x-forwarded-for when the platform's header is present
    const ip = "203.0.113.50";
    let last = 200;
    for (let i = 0; i < 25; i++) {
      h.jar.clear();
      last = (await GET(new Request("https://roam.example/tv/pair", { headers: { "x-vercel-forwarded-for": ip, "x-forwarded-for": `9.9.9.${i}`, "user-agent": "Tizen" } }))).status;
    }
    expect(last).toBe(429);
  });
  it("points the phone's link at the main site even when the TV came in through another address, and decodes to the code", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://main.example");
    const res = await GET(new Request("https://short.example/tv/pair", { headers: { "x-vercel-forwarded-for": "198.51.100.231", "user-agent": "Tizen" } }));
    vi.unstubAllEnvs();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const body = await res.text();
    expect(body).toContain("main.example/link");
    expect(body).not.toContain("short.example");
  });
  it("keeps the same code when the screen is reloaded, instead of spending another", async () => {
    const first = code(await (await getPage()).text());
    const again = code(await (await getPage()).text());
    expect(again).toBe(first);
    expect(await db.select().from(tvPairings).where(eq(tvPairings.userCode, first.replace("-", "")))).toHaveLength(1);
  });
  it("sends a TV that is already signed in on to the home screen", async () => {
    h.signedIn = true;
    const res = await getPage();
    expect([res.status, res.headers.get("location")]).toEqual([302, "https://roam.example/tv"]);
    expect(h.jar.size).toBe(0);
  });
  it("tells a TV that asks too often to wait", async () => {
    const ip = "203.0.113.200";
    let last = 200;
    for (let i = 0; i < 25; i++) {
      h.jar.clear(); // a fresh TV each time
      last = (await getPage(ip)).status;
    }
    expect(last).toBe(429);
  });
});

describe("POST /tv/pair/poll", () => {
  const poll = async () => (await POST()).json();
  it("says expired when there is no pairing, and pending while waiting", async () => {
    expect(await poll()).toEqual({ status: "expired" });
    await getPage();
    expect(await poll()).toEqual({ status: "pending" });
    expect(h.minted).toEqual([]);
  });
  it("signs the TV in once the code is approved, then forgets the pairing", async () => {
    const who = await makeAccount(db, "tvuser");
    const shown = code(await (await getPage()).text()).replace("-", "");
    await approvePairing(db, { userCode: shown, accountId: who.accountId });
    expect(await poll()).toEqual({ status: "approved" });
    expect(h.minted).toEqual([who.accountId]);
    expect(h.jar.has(TV_PAIR_COOKIE)).toBe(false);
    expect(await poll()).toEqual({ status: "expired" });
    expect(h.minted).toHaveLength(1);
  });
  it("does not claim success when the session could not be made, and tries again on the next poll instead of losing the approval", async () => {
    const who = await makeAccount(db, "tvfail");
    const shown = code(await (await getPage()).text()).replace("-", "");
    await approvePairing(db, { userCode: shown, accountId: who.accountId });
    h.mintOk = false;
    expect(await poll()).toEqual({ status: "pending" });
    expect(h.jar.has(TV_PAIR_COOKIE)).toBe(true);
    h.mintOk = true;
    expect(await poll()).toEqual({ status: "approved" });
    expect(h.minted).toHaveLength(2);
  });
});
