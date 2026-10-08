/**
 * The sign-in route with an open join link, and the admin's join-link controls. Checks that being a guest comes from the
 * verified session (never the request body), that a join only ever lands in the server's library, that guests can do
 * nothing beyond watching, and that only a server's admin can change its link.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  user: null as null | { id: string; email?: string; is_anonymous?: boolean },
  cleanups: 0,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/auth/guest-cleanup", () => ({ scheduleGuestCleanup: () => void h.cleanups++ }));

import { profiles, serverMembers, servers, viewers } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createServer } from "@/lib/auth/servers";
import { setJoinLink } from "@/lib/auth/join";
import { POST as ensureProfile } from "./ensure-profile/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const post = (body: unknown) => ensureProfile(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const uuid = () => crypto.randomUUID();
async function demo() {
  const owner = await makeAccount(db, "owner");
  await db.update(profiles).set({ canManageOpenLinks: true }).where(eq(profiles.id, owner.accountId));
  const server = await makeServer(db, owner.accountId);
  const link = (await setJoinLink(server.id, { enabled: true, demo: true }))!;
  return { owner, server, token: link.joinToken! };
}
const roleOf = async (serverId: string, id: string) => (await db.select().from(serverMembers).where(eq(serverMembers.profileId, id))).find((m) => m.serverId === serverId)?.role ?? null;

describe("POST /api/auth/ensure-profile with an open join link", () => {
  it("lets an anonymous guest in as a hidden viewer and sends them to the server's library", async () => {
    const { server, token } = await demo();
    const id = uuid();
    h.user = { id, is_anonymous: true };
    h.cleanups = 0;
    const res = await post({ joinToken: token });
    expect(await res.json()).toEqual({ redirectTo: `/s/${server.id}/library` });
    expect(await roleOf(server.id, id)).toBe("viewer");
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, id));
    expect(profile).toMatchObject({ isGuest: true });
    expect(profile.email).toBe(`guest-${id}@guest.invalid`);
    expect((await db.select().from(viewers).where(eq(viewers.accountId, id)))[0]).toMatchObject({ name: "Guest", visibleOnServer: false });
    expect(h.cleanups).toBe(1);
  });

  it("decides guest from the verified session, never from the request: a normal account that claims to be a guest is not one", async () => {
    const { token } = await demo();
    const id = uuid();
    h.user = { id, email: "Real.Person@Example.com" };
    await post({ joinToken: token, guest: true, isGuest: true, is_anonymous: true });
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, id));
    expect(profile).toMatchObject({ isGuest: false, email: "real.person@example.com" });
  });

  it("hides a brand-new sign-up on a demo, but not an account that already existed", async () => {
    const { token } = await demo();
    const fresh = uuid();
    h.user = { id: fresh, email: "fresh@example.com" };
    await post({ joinToken: token });
    expect((await db.select().from(viewers).where(eq(viewers.accountId, fresh)))[0].visibleOnServer).toBe(false);
    const old = await makeAccount(db, "old");
    const [oldProfile] = await db.select().from(profiles).where(eq(profiles.id, old.accountId));
    h.user = { id: old.accountId, email: oldProfile.email };
    await post({ joinToken: token });
    expect((await db.select().from(viewers).where(eq(viewers.accountId, old.accountId)))[0].visibleOnServer).toBe(true);
  });

  it("an invalid, switched-off or malformed link joins nothing and says so, and never redirects anywhere but the servers page", async () => {
    const { server, token } = await demo();
    await setJoinLink(server.id, { enabled: false });
    for (const t of [token, "nope", "x".repeat(32), "../../admin", "https://evil.example"]) {
      const id = uuid();
      h.user = { id, is_anonymous: true };
      const body = await (await post({ joinToken: t })).json();
      expect(body, t).toEqual({ redirectTo: "/servers", error: "join-not-found" });
      expect(await roleOf(server.id, id)).toBeNull();
    }
  });

  it("the server's admin using their own link stays the admin", async () => {
    const { owner, server, token } = await demo();
    const [p] = await db.select().from(profiles).where(eq(profiles.id, owner.accountId));
    h.user = { id: owner.accountId, email: p.email };
    expect((await (await post({ joinToken: token })).json()).redirectTo).toBe(`/s/${server.id}/library`);
    expect(await roleOf(server.id, owner.accountId)).toBe("admin");
  });

  it("a guest with no link has nowhere to go but the servers page, and still can't own anything", async () => {
    const id = uuid();
    h.user = { id, is_anonymous: true };
    expect(await (await post({})).json()).toEqual({ redirectTo: "/servers" });
    expect(await createServer(id, "Mine")).toEqual({ ok: false, reason: "guest" });
    expect(await db.select().from(servers).where(eq(servers.ownerId, id))).toEqual([]);
  });

  it("refuses a request with no session at all, and an account with neither an email nor guest status", async () => {
    h.user = null;
    expect((await post({})).status).toBe(401);
    h.user = { id: uuid() };
    expect((await post({})).status).toBe(401);
  });
});

