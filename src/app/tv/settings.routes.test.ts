/** A profile's own settings on a TV: who may change them, the PIN check, and what each button does. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  profile: null as unknown,
  jar: new Map<string, string>(),
  signedOut: 0,
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
vi.mock("@/lib/auth/viewer", async () => {
  const { eq } = await import("drizzle-orm");
  const { viewers } = await import("@/lib/db/schema");
  return {
    getCurrentViewer: async () => h.resolution,
    listViewers: async (accountId: string) => h.testDb.db.select().from(viewers).where(eq(viewers.accountId, accountId)),
  };
});
vi.mock("@/lib/auth/guards", async () => {
  const { and, eq } = await import("drizzle-orm");
  const { serverMembers } = await import("@/lib/db/schema");
  return {
    getCurrentProfile: async () => h.profile,
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { hashPin } from "@/lib/viewers/pin";
import { UNLOCK_COOKIE } from "@/lib/tv/settings";
import { GET as home } from "./s/[serverId]/route";

import { GET as settingsGet, POST as settingsPost } from "./s/[serverId]/settings/route";
import { POST as unlockPost } from "./s/[serverId]/settings/unlock/route";

let db: TestDb;
beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = h.testDb.db;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  h.resolution = null;
  h.profile = null;
  h.jar.clear();
});

const req = (path: string) => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const text = async (r: Response) => r.text();
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`https://roam.example${path}`, { method: "POST", headers, body: new URLSearchParams(fields) });

async function signIn(who: Awaited<ReturnType<typeof makeAccount>>, pick?: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, who.accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === (pick ?? who.viewer.id)) ?? all[0], viewers: all };
  h.profile = account;
}

let n = 0;
async function world() {
  const admin = await makeAccount(db, `admin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `member${++n}`);
  await joinServer(db, server.id, member.accountId);
  await signIn(member);
  return { server, member, sid: { serverId: server.id } };
}
const row = async (id: string) => (await db.select().from(viewers).where(eq(viewers.id, id)))[0];
const press = async (w: Awaited<ReturnType<typeof world>>, kind: string, key: string) => {
  const res = await settingsPost(post("/x", { kind, key }), ctx(w.sid));
  await signIn(w.member, (h.resolution as { viewer: { id: string } } | null)?.viewer.id);
  return res;
};

describe("the Settings button", () => {
  it("is on the home screen for a profile that may change its settings, and not for a child's", async () => {
    const w = await world();
    expect(await text(await home(req("/x"), ctx(w.sid)))).toContain(`/tv/s/${w.server.id}/settings`);
    const [kid] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Kid", role: "limited", sortOrder: 5 }).returning();
    await signIn(w.member, kid.id);
    expect(await text(await home(req("/x"), ctx(w.sid)))).not.toContain("/settings");
  });
});

describe("what to skip", () => {
  it("lists every category and automatic skip with where it stands", async () => {
    const w = await world();
    const page = await text(await settingsGet(req("/x"), ctx(w.sid)));
    expect(page).toContain("Settings for member");
    expect(page).toContain("Violence: Off");
    expect(page).toContain("Language: Off");
    expect(page).toContain("Intros: Off");
    expect(page).toContain("Credits (go to the next episode): Off");
    expect(page.match(/name="kind" value="filter"/g)).toHaveLength(11);
    expect(page.match(/name="kind" value="auto"/g)).toHaveLength(4);
    expect(page).toContain("Group collections in lists: Off");
  });

  it("cycles a category through mild, moderate, strong and back to off, saving each, and comes back to the same button", async () => {
    const w = await world();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await press(w, "filter", "violence");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/settings?f=filter:violence`);
      seen.push(JSON.stringify((await row(w.member.viewer.id)).contentFilter));
    }
    expect(seen).toEqual(['{"violence":"low"}', '{"violence":"medium"}', '{"violence":"high"}', "{}"]);
    await press(w, "filter", "language");
    const page = await text(await settingsGet(req("/x?f=filter:language"), ctx(w.sid)));
    expect(page).toContain("Language: Mild and up");
    expect(page).toMatch(/value="language"><button[^>]*data-autofocus>Language: Mild and up/);
  });

  it("switches an automatic skip on and off", async () => {
    const w = await world();
    await press(w, "auto", "intro");
    expect((await row(w.member.viewer.id)).autoSkip).toEqual({ intro: true });
    expect(await text(await settingsGet(req("/x"), ctx(w.sid)))).toContain("Intros: On");
    await press(w, "auto", "intro");
    expect((await row(w.member.viewer.id)).autoSkip).toEqual({});
  });

  it("switches grouping of collections on and off", async () => {
    const w = await world();
    await press(w, "group", "collections");
    expect((await row(w.member.viewer.id)).groupCollections).toBe(true);
    expect(await text(await settingsGet(req("/x?f=group:collections"), ctx(w.sid)))).toContain("Group collections in lists: On");
    await press(w, "group", "collections");
    expect((await row(w.member.viewer.id)).groupCollections).toBe(false);
  });

  it("refuses nonsense, a request from another site, and a child's profile", async () => {
    const w = await world();
    expect((await settingsPost(post("/x", { kind: "filter", key: "nope" }), ctx(w.sid))).status).toBe(404);
    expect((await settingsPost(post("/x", { kind: "other", key: "intro" }), ctx(w.sid))).status).toBe(404);
    expect((await settingsPost(post("/x", { kind: "auto", key: "intro" }, { origin: "https://evil.example" }), ctx(w.sid))).status).toBe(404);
    expect((await row(w.member.viewer.id)).autoSkip).toEqual({});
    const [kid] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Kid", role: "limited", sortOrder: 5 }).returning();
    await signIn(w.member, kid.id);
    expect((await settingsGet(req("/x"), ctx(w.sid))).status).toBe(403);
    expect((await settingsPost(post("/x", { kind: "auto", key: "intro" }), ctx(w.sid))).status).toBe(403);
    expect((await row(kid.id)).autoSkip).toEqual({});
    expect(await text(await settingsGet(req("/x"), ctx(w.sid)))).not.toContain("Violence");
  });

  it("is signed-in only", async () => {
    const w = await world();
    h.resolution = null;
    expect((await settingsGet(req("/x"), ctx(w.sid))).status).toBe(302);
  });
});

describe("a profile with a PIN", () => {
  async function protectedWorld() {
    const w = await world();
    await db.update(viewers).set({ pinHash: hashPin("4321") }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    return w;
  }

  it("is asked for the PIN before the page opens, and nothing changes without it", async () => {
    const w = await protectedWorld();
    const page = await text(await settingsGet(req("/x"), ctx(w.sid)));
    expect(page).toContain("Enter your PIN to change settings");
    expect(page).toContain('data-pin-digit="5"');
    expect(page).not.toContain("Violence");
    const res = await settingsPost(post("/x", { kind: "auto", key: "intro" }), ctx(w.sid));
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/settings`);
    expect((await row(w.member.viewer.id)).autoSkip).toEqual({});
  });

  it("opens the page for the right PIN, and refuses a wrong one and too many tries", async () => {
    const w = await protectedWorld();
    const wrong = await unlockPost(post("/x", { pin: "1111" }), ctx(w.sid));
    expect(wrong.status).toBe(401);
    expect(await text(wrong)).toContain("That PIN isn&#39;t right.");
    expect(h.jar.has(UNLOCK_COOKIE)).toBe(false);
    const right = await unlockPost(post("/x", { pin: "4321" }), ctx(w.sid));
    expect(right.status).toBe(303);
    expect(h.jar.has(UNLOCK_COOKIE)).toBe(true);
    expect(await text(await settingsGet(req("/x"), ctx(w.sid)))).toContain("Violence: Off");
    await settingsPost(post("/x", { kind: "auto", key: "recap" }), ctx(w.sid));
    expect((await row(w.member.viewer.id)).autoSkip).toEqual({ recap: true });
  });

  it("stops guessing after a few tries", async () => {
    const w = await protectedWorld();
    // The limiter counts in fixed windows of fifteen minutes; keep the clock mid-window so the tries can't straddle two.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T14:07:00Z"));
    try {
      for (let i = 0; i < 5; i++) await unlockPost(post("/x", { pin: "0000" }), ctx(w.sid));
      expect((await unlockPost(post("/x", { pin: "4321" }), ctx(w.sid))).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
    expect(h.jar.has(UNLOCK_COOKIE)).toBe(false);
  });
  it("does not accept the pass after the PIN is changed", async () => {
    const w = await protectedWorld();
    await unlockPost(post("/x", { pin: "4321" }), ctx(w.sid));
    await db.update(viewers).set({ pinHash: hashPin("9999"), pinVersion: 1 }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    expect(await text(await settingsGet(req("/x"), ctx(w.sid)))).toContain("Enter your PIN to change settings");
  });
});
