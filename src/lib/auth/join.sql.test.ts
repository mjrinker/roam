/** The open join link and guests: viewer-only, idempotent, never changes a role, and a guest's cleanup leaves nothing behind. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, allow: true }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => h.allow }));

import { playlistItems, playlists, profiles, serverMembers, servers, viewers, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makePlaylist, makeServer } from "@/lib/playlists/test-db";
import { deleteInactiveGuests, GUEST_INACTIVE_DAYS, guestEmail, touchGuest } from "./guests";
import { ensureProfileWithStatus } from "./invites";
import { acceptJoin, getJoinTarget, setJoinLink } from "./join";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const roleOf = async (serverId: string, accountId: string) =>
  (await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.profileId, accountId))))[0]?.role ?? null;
const viewersOf = (accountId: string) => db.select().from(viewers).where(eq(viewers.accountId, accountId));
const uuid = () => crypto.randomUUID();

async function demoServer(demo = true) {
  const owner = await makeAccount(db, "owner");
  await db.update(profiles).set({ canManageOpenLinks: true }).where(eq(profiles.id, owner.accountId));
  const server = await makeServer(db, owner.accountId);
  const link = (await setJoinLink(server.id, { enabled: true, demo }))!;
  return { owner, server, token: link.joinToken! };
}

describe("the join link (admin side)", () => {
  it("is switched on, replaced and switched off, and a replaced or disabled link stops working", async () => {
    const owner = await makeAccount(db, "o");
    await db.update(profiles).set({ canManageOpenLinks: true }).where(eq(profiles.id, owner.accountId));
    const server = await makeServer(db, owner.accountId);
    expect((await setJoinLink(server.id, {}))!.joinToken).toBeNull();
    const on = (await setJoinLink(server.id, { enabled: true }))!;
    expect(on.joinToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await setJoinLink(server.id, { enabled: true }))!.joinToken).toBe(on.joinToken); // turning on twice keeps it
    expect(await getJoinTarget(on.joinToken!)).toMatchObject({ serverId: server.id });
    const rotated = (await setJoinLink(server.id, { rotate: true }))!;
    expect(rotated.joinToken).not.toBe(on.joinToken);
    expect(await getJoinTarget(on.joinToken!)).toBeNull();
    expect(await getJoinTarget(rotated.joinToken!)).not.toBeNull();
    expect((await setJoinLink(server.id, { enabled: false }))!.joinToken).toBeNull();
    expect(await getJoinTarget(rotated.joinToken!)).toBeNull();
    expect(await setJoinLink(uuid(), { enabled: true })).toBeNull(); // no such server
  });

  it("a link only works while the server's owner holds the permission: taking it away switches every link off at once", async () => {
    const { owner, server, token } = await demoServer();
    expect(await getJoinTarget(token)).not.toBeNull();
    await db.update(profiles).set({ canManageOpenLinks: false }).where(eq(profiles.id, owner.accountId));
    expect(await getJoinTarget(token)).toBeNull();
    const a = await makeAccount(db, "a");
    expect(await acceptJoin(token, { id: a.accountId })).toEqual({ ok: false, reason: "not_found" });
    expect(await roleOf(server.id, a.accountId)).toBeNull();
    await db.update(profiles).set({ canManageOpenLinks: true }).where(eq(profiles.id, owner.accountId));
    expect(await getJoinTarget(token)).not.toBeNull(); // the link itself was never deleted
  });

  it("rotating a link that is off does not switch it on, and the demo flag changes independently", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    expect((await setJoinLink(server.id, { rotate: true }))!.joinToken).toBeNull();
    expect(await setJoinLink(server.id, { demo: true })).toEqual({ joinToken: null, isDemo: true });
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0].isDemo).toBe(true);
  });

  it("only ever recognises a well-formed token", async () => {
    const { token } = await demoServer();
    for (const bad of ["", "short", "x".repeat(65), `${token}!`, `${token} `, "' OR 1=1 --", "../etc/passwd", token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()]) {
      expect(await getJoinTarget(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(await getJoinTarget(token)).not.toBeNull();
  });
});

describe("joining", () => {
  it("makes a viewer, as often as the link is used, and the same person twice is still one membership", async () => {
    const { server, token } = await demoServer();
    const a = await makeAccount(db, "a");
    expect(await acceptJoin(token, { id: a.accountId })).toEqual({ ok: true, serverId: server.id, isDemo: true });
    expect(await acceptJoin(token, { id: a.accountId })).toMatchObject({ ok: true });
    const b = await makeAccount(db, "b");
    expect(await acceptJoin(token, { id: b.accountId })).toMatchObject({ ok: true });
    expect([await roleOf(server.id, a.accountId), await roleOf(server.id, b.accountId)]).toEqual(["viewer", "viewer"]);
    expect((await db.select().from(serverMembers).where(eq(serverMembers.serverId, server.id))).filter((m) => m.profileId === a.accountId)).toHaveLength(1);
  });

  it("never changes the role of someone already a member: the admin using their own link stays the admin", async () => {
    const { owner, server, token } = await demoServer();
    expect(await acceptJoin(token, { id: owner.accountId })).toMatchObject({ ok: true });
    expect(await roleOf(server.id, owner.accountId)).toBe("admin");
    const member = await makeAccount(db, "m");
    await joinServer(db, server.id, member.accountId, "viewer");
    await acceptJoin(token, { id: member.accountId });
    expect(await roleOf(server.id, member.accountId)).toBe("viewer");
  });

  it("is the same 'not found' for a switched-off, replaced, unknown or malformed link", async () => {
    const { server, token } = await demoServer();
    const a = await makeAccount(db, "a");
    await setJoinLink(server.id, { rotate: true });
    for (const t of [token, "A".repeat(32), "nope"]) expect(await acceptJoin(t, { id: a.accountId }), t).toEqual({ ok: false, reason: "not_found" });
    expect(await roleOf(server.id, a.accountId)).toBeNull();
  });

  it("hides a brand-new account's profiles on a demo server only, and never touches an account that was not asked to hide", async () => {
    const demo = await demoServer(true);
    const plain = await demoServer(false);
    const fresh = await makeAccount(db, "fresh");
    const old = await makeAccount(db, "old");
    await acceptJoin(demo.token, { id: fresh.accountId }, { hide: true });
    await acceptJoin(demo.token, { id: old.accountId }); // an existing account: no hide asked
    expect((await viewersOf(fresh.accountId)).every((v) => !v.visibleOnServer)).toBe(true);
    expect((await viewersOf(old.accountId)).every((v) => v.visibleOnServer)).toBe(true);
    const other = await makeAccount(db, "other");
    await acceptJoin(plain.token, { id: other.accountId }, { hide: true }); // not a demo server: nothing hidden
    expect((await viewersOf(other.accountId)).every((v) => v.visibleOnServer)).toBe(true);
  });

  it("lets a guest in only through a demo's link: a family server's open link needs a real sign-in", async () => {
    const demo = await demoServer(true);
    const family = await demoServer(false);
    const g = await makeAccount(db, "g");
    expect(await acceptJoin(family.token, { id: g.accountId }, { guest: true })).toEqual({ ok: false, reason: "not_found" });
    expect(await roleOf(family.server.id, g.accountId)).toBeNull();
    expect(await acceptJoin(demo.token, { id: g.accountId }, { guest: true })).toMatchObject({ ok: true });
    expect(await acceptJoin(family.token, { id: g.accountId })).toMatchObject({ ok: true }); // a real sign-in is fine
  });

  it("is limited per account, and a limited join adds nothing", async () => {
    const { server, token } = await demoServer();
    const a = await makeAccount(db, "a");
    h.allow = false;
    try {
      expect(await acceptJoin(token, { id: a.accountId })).toEqual({ ok: false, reason: "rate_limited" });
    } finally {
      h.allow = true;
    }
    expect(await roleOf(server.id, a.accountId)).toBeNull();
  });
});

describe("guest accounts", () => {
  it("get a placeholder address that can't receive mail, a hidden 'Guest' profile and the guest flag", async () => {
    const id = uuid();
    const { profile, created } = await ensureProfileWithStatus(id, null, { guest: true });
    expect(created).toBe(true);
    expect(profile).toMatchObject({ isGuest: true, email: guestEmail(id) });
    expect(profile.email.endsWith("@guest.invalid")).toBe(true);
    expect(await viewersOf(id)).toMatchObject([{ name: "Guest", visibleOnServer: false, role: "owner" }]);
    const again = await ensureProfileWithStatus(id, null, { guest: true });
    expect(again.created).toBe(false);
  });

  it("a normal sign-up is not a guest and is visible by default, named from its address as before", async () => {
    const { profile, created } = await ensureProfileWithStatus(uuid(), "Jane.Doe@Example.com");
    expect(created).toBe(true);
    expect(profile).toMatchObject({ isGuest: false, email: "jane.doe@example.com" });
    expect((await viewersOf(profile.id))[0]).toMatchObject({ name: "jane.doe", visibleOnServer: true });
  });

  it("is recorded as seen at most once an hour", async () => {
    const { profile } = await ensureProfileWithStatus(uuid(), null, { guest: true });
    // Relative to the real clock: a fixed date here would one day be "a week ago" and make the cleanup test below delete this guest too.
    const t0 = new Date();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    await touchGuest(profile, t0);
    const seen = async () => (await db.select().from(profiles).where(eq(profiles.id, profile.id)))[0].lastSeenAt;
    expect(await seen()).toEqual(t0);
    await touchGuest({ ...profile, lastSeenAt: t0 }, at(30));
    expect(await seen()).toEqual(t0); // too soon
    await touchGuest({ ...profile, lastSeenAt: t0 }, at(61));
    expect(await seen()).toEqual(at(61));
    const member = await makeAccount(db, "member");
    const real = (await db.select().from(profiles).where(eq(profiles.id, member.accountId)))[0];
    await touchGuest(real, t0); // not a guest: never written
    expect((await db.select().from(profiles).where(eq(profiles.id, member.accountId)))[0].lastSeenAt).toBeNull();
  });
});

describe("cleaning up inactive guests", () => {
  const now = new Date(); // the guests other tests created are minutes old, so none of them are stale
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  async function guest(lastSeen: Date | null, createdDaysAgo: number) {
    const id = uuid();
    await ensureProfileWithStatus(id, null, { guest: true });
    await db.update(profiles).set({ lastSeenAt: lastSeen, createdAt: daysAgo(createdDaysAgo) }).where(eq(profiles.id, id));
    return id;
  }
  const exists = async (id: string) => (await db.select().from(profiles).where(eq(profiles.id, id))).length === 1;

  it("removes guests inactive for the whole period, keeps recent ones (even if old accounts), and never touches a real account", async () => {
    const stale = await guest(daysAgo(GUEST_INACTIVE_DAYS + 1), 40);
    const neverSeen = await guest(null, GUEST_INACTIVE_DAYS + 2);
    const active = await guest(daysAgo(1), 60); // old account, seen yesterday
    const brandNew = await guest(null, 0);
    const real = await makeAccount(db, "real");
    await db.update(profiles).set({ createdAt: daysAgo(400) }).where(eq(profiles.id, real.accountId));
    const gone: string[] = [];
    const result = await deleteInactiveGuests(async (id) => void gone.push(id), { now });
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(gone.sort()).toEqual([stale, neverSeen].sort());
    expect([await exists(stale), await exists(neverSeen), await exists(active), await exists(brandNew), await exists(real.accountId)]).toEqual([false, false, true, true, true]);
  });

  it("takes everything with them: profile, memberships, watch history and the playlists they made (which would otherwise outlive them)", async () => {
    const { server, token } = await demoServer();
    const id = await guest(daysAgo(30), 30);
    await acceptJoin(token, { id });
    const pl = await makePlaylist(db, { serverId: server.id, ownerViewerId: id, visibility: "server" });
    await db.insert(watchState).values({ viewerId: id, ownerKind: "title", ownerId: uuid(), positionSeconds: 5 });
    const other = await makeAccount(db, "other");
    const otherPl = await makePlaylist(db, { serverId: server.id, ownerViewerId: other.viewer.id, visibility: "server" });
    await deleteInactiveGuests(async () => undefined, { now });
    expect(await exists(id)).toBe(false);
    expect(await roleOf(server.id, id)).toBeNull();
    expect(await db.select().from(watchState).where(eq(watchState.viewerId, id))).toEqual([]);
    expect(await db.select().from(playlists).where(eq(playlists.id, pl.id))).toEqual([]);
    expect(await db.select().from(playlists).where(eq(playlists.id, otherPl.id))).toHaveLength(1); // someone else's playlist is untouched
    void playlistItems;
  });

  it("deletes the sign-in only after the data, skips a guest that came back meanwhile, and survives a failing sign-in delete", async () => {
    const id = await guest(daysAgo(30), 30);
    const seenWhenDeleted: boolean[] = [];
    await deleteInactiveGuests(async (g) => void seenWhenDeleted.push(await exists(g)), { now });
    expect(seenWhenDeleted).toEqual([false]); // the data was already gone when the sign-in was removed

    const back = await guest(daysAgo(30), 30);
    await db.update(profiles).set({ lastSeenAt: daysAgo(0) }).where(eq(profiles.id, back)); // came back after being listed
    const none = await deleteInactiveGuests(async () => undefined, { now });
    expect(none.deleted).toBe(0);
    expect(await exists(back)).toBe(true);

    const flaky = await guest(daysAgo(30), 30);
    const result = await deleteInactiveGuests(async () => { throw new Error("auth down"); }, { now });
    expect(result).toEqual({ deleted: 0, failed: 1 });
    expect(await exists(flaky)).toBe(false); // data gone; the harmless leftover login is re-handled next time it signs in
    void id;
  });

  it("does at most `limit` per call", async () => {
    for (let i = 0; i < 5; i++) await guest(daysAgo(30), 30);
    expect((await deleteInactiveGuests(async () => undefined, { now, limit: 2 })).deleted).toBe(2);
  });
});
