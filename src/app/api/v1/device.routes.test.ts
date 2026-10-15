/** Signing an app in with a code, using its token, choosing a profile, and signing it out: the whole device flow against a real database. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
// No browser session at all: only a device token can sign anyone in here.
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { eq } from "drizzle-orm";
import { deviceTokens, viewers } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { approvePairing } from "@/lib/tv/pairing";
import { hashPin } from "@/lib/viewers/pin";
import { POST as start } from "./device/start/route";
import { POST as poll } from "./device/poll/route";
import { GET as me } from "./me/route";
import { POST as chooseProfile } from "./me/profile/route";
import { DELETE as signOut } from "./session/route";
import { GET as devices } from "./devices/route";
import { DELETE as revoke } from "./devices/[id]/route";
import { GET as notifications } from "../notifications/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const post = (body: unknown) => new Request("https://roam.example/x", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
/** Starts a pairing as an app, approves it as the account, and polls: returns the app's token. */
async function signInApp(accountId: string, label = "Living room Roku") {
  const started = await json(await start(post({ label })));
  const code = String(started.userCode).replace(/[\s-]/g, "");
  expect(await approvePairing(db, { userCode: code, accountId })).toBe(true);
  const done = await json(await poll(post({ deviceCode: started.deviceCode })));
  return { started, done, token: done.accessToken as string };
}
const as = (token: string) => {
  h.headers = { authorization: `Bearer ${token}` };
};

describe("signing an app in", () => {
  it("gives a code and a secret, then a token once the code is approved, and the token is shown only once", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const started = await json(await start(post({ label: "Living room Roku" })));
    expect(started.userCode).toMatch(/^[A-Z2-9]{5}$/);
    expect(started.verificationUrl).toMatch(/\/link$/);
    expect(started.verificationUrlComplete).toContain(`code=${started.userCode}`);
    expect(started.interval).toBeGreaterThan(0);
    const pending = await json(await poll(post({ deviceCode: started.deviceCode })));
    expect(pending).toEqual({ status: "pending" });
    await approvePairing(db, { userCode: started.userCode, accountId: acct.accountId });
    const done = await json(await poll(post({ deviceCode: started.deviceCode })));
    expect(done.status).toBe("approved");
    expect(done.accessToken).toMatch(/^rdt_[A-Za-z0-9_-]{43}$/);
    expect(done.profiles).toHaveLength(1);
    expect(done.profileSelected).toBe(true); // one profile, no PIN: nothing to choose
    expect(JSON.stringify(done)).not.toContain("pinHash");
    expect((await json(await poll(post({ deviceCode: started.deviceCode })))).status).toBe("expired"); // handed over once
    // Only a hash of the token is kept.
    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.accountId, acct.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(done.accessToken);
    expect(rows[0].label).toBe("Living room Roku");
  });

  it("refuses nonsense and a wrong secret the same way as an expired one", async () => {
    expect((await poll(post({ deviceCode: "x" }))).status).toBe(400);
    expect((await poll(post({}))).status).toBe(400);
    expect((await json(await poll(post({ deviceCode: "a".repeat(43) })))).status).toBe("expired");
    expect((await start(post({ label: 5 }))).status).toBe(400);
  });

  it("cleans the name the device gives itself", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const { token } = await signInApp(acct.accountId, "  <b>Den</b>\n\tTV  ");
    as(token);
    expect((await json(await devices())).devices[0].label).toBe("bDen/bTV");
  });
});

describe("using the token", () => {
  it("is the account: /api/v1/me and any existing endpoint, and it never needs a browser session", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const { token } = await signInApp(acct.accountId);
    h.headers = {};
    expect((await me()).status).toBe(401); // no token, no session
    as(token);
    const who = await json(await me());
    expect(who.account.id).toBe(acct.accountId);
    expect(who.profile.id).toBe(acct.viewer.id);
    expect(who.profiles).toHaveLength(1);
    expect((await notifications()).status).toBe(200); // an endpoint written long before tokens existed
  });

  it("is signed out by a bad or malformed token, never falling back to anything else", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const { token } = await signInApp(acct.accountId);
    for (const bad of [`Bearer rdt_${"A".repeat(43)}`, "Bearer nope", `Bearer ${token}x`, `Basic ${token}`, "Bearer "]) {
      h.headers = { authorization: bad };
      expect((await me()).status).toBe(401);
    }
  });

  it("needs a profile to be chosen when there are several, checks the PIN, and signs the profile out when its PIN changes", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const [kid] = await db.insert(viewers).values({ accountId: acct.accountId, name: "Kid", role: "limited", sortOrder: 2 }).returning();
    const [dad] = await db.insert(viewers).values({ accountId: acct.accountId, name: "Dad", role: "admin", pinHash: hashPin("1234"), sortOrder: 3 }).returning();
    const { token, done } = await signInApp(acct.accountId);
    expect(done.profileSelected).toBe(false);
    expect(done.profiles.map((p: { name: string; hasPin: boolean }) => [p.name, p.hasPin])).toContainEqual(["Dad", true]);
    as(token);
    expect((await json(await me())).profile).toBeNull();
    // A profile of someone else, a missing PIN and a wrong one are refused; the right one is accepted.
    const stranger = await makeAccount(db, `dev${++n}`);
    expect((await chooseProfile(post({ viewerId: stranger.viewer.id }))).status).toBe(404);
    expect((await chooseProfile(post({ viewerId: dad.id }))).status).toBe(401);
    expect((await chooseProfile(post({ viewerId: dad.id, pin: "0000" }))).status).toBe(401);
    expect((await json(await me())).profile).toBeNull();
    expect((await chooseProfile(post({ viewerId: dad.id, pin: "1234" }))).status).toBe(200);
    expect((await json(await me())).profile.id).toBe(dad.id);
    expect((await chooseProfile(post({ viewerId: kid.id }))).status).toBe(200);
    expect((await json(await me())).profile.name).toBe("Kid");
    // Changing a profile's PIN signs it out of every device.
    await chooseProfile(post({ viewerId: dad.id, pin: "1234" }));
    await db.update(viewers).set({ pinHash: hashPin("9999"), pinVersion: dad.pinVersion + 1 }).where(eq(viewers.id, dad.id));
    expect((await json(await me())).profile).toBeNull();
  });

  it("limits PIN guessing", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const [dad] = await db.insert(viewers).values({ accountId: acct.accountId, name: "Dad", role: "admin", pinHash: hashPin("1234"), sortOrder: 3 }).returning();
    const { token } = await signInApp(acct.accountId);
    as(token);
    for (let i = 0; i < 5; i++) await chooseProfile(post({ viewerId: dad.id, pin: "0000" }));
    expect((await chooseProfile(post({ viewerId: dad.id, pin: "1234" }))).status).toBe(429);
  });

  it("is not for browser sessions where a device token is needed", async () => {
    h.headers = {};
    expect((await chooseProfile(post({ viewerId: "00000000-0000-4000-8000-000000000001" }))).status).toBe(401);
    expect((await signOut()).status).toBe(400);
  });
});

describe("devices", () => {
  it("lists this account's devices (never their tokens), marks the current one, and signs one out", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const a = await signInApp(acct.accountId, "Roku");
    const b = await signInApp(acct.accountId, "Kodi");
    as(a.token);
    const list = await json(await devices());
    expect(list.devices.map((d: { label: string; current: boolean }) => [d.label, d.current]).sort()).toEqual([["Kodi", false], ["Roku", true]]);
    expect(JSON.stringify(list)).not.toContain(a.token);
    const kodi = list.devices.find((d: { label: string }) => d.label === "Kodi");
    expect((await revoke(new Request("https://roam.example/x", { method: "DELETE" }), { params: Promise.resolve({ id: kodi.id }) } as never)).status).toBe(200);
    as(b.token);
    expect((await me()).status).toBe(401); // that device is out
    as(a.token);
    expect((await me()).status).toBe(200);
    expect((await json(await devices())).devices).toHaveLength(1);
  });

  it("will not sign out someone else's device, or one that doesn't exist", async () => {
    const mine = await makeAccount(db, `dev${++n}`);
    const theirs = await makeAccount(db, `dev${++n}`);
    const t = await signInApp(theirs.accountId);
    const m = await signInApp(mine.accountId);
    as(t.token);
    const theirId = (await json(await devices())).devices[0].id as string;
    as(m.token);
    const del = (id: string) => revoke(new Request("https://roam.example/x", { method: "DELETE" }), { params: Promise.resolve({ id }) } as never);
    expect((await del(theirId)).status).toBe(404);
    expect((await del("00000000-0000-4000-8000-0000000000aa")).status).toBe(404);
    expect((await del("not-a-uuid")).status).toBe(404);
    as(t.token);
    expect((await me()).status).toBe(200);
  });

  it("signs itself out", async () => {
    const acct = await makeAccount(db, `dev${++n}`);
    const { token } = await signInApp(acct.accountId);
    as(token);
    expect((await signOut()).status).toBe(200);
    expect((await me()).status).toBe(401);
  });
});
