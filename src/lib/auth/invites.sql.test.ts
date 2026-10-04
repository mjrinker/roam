/** One admin per server: invites only make viewers, accepting never changes a role, and the database refuses a second admin. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));

import { invites, profiles, serverMembers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeServer } from "@/lib/playlists/test-db";
import { acceptInvite, createInvite } from "./invites";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const roleOf = async (serverId: string, accountId: string) =>
  (await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.profileId, accountId))))[0]?.role ?? null;

async function emailOf(accountId: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  return p.email;
}

describe("invites make viewers only", () => {
  it("creates a viewer invite, and re-inviting keeps it a viewer", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const first = await createInvite("New@Example.com", server.id, admin.accountId);
    const again = await createInvite("new@example.com", server.id, admin.accountId);
    if (!first.invite || !again.invite) throw new Error("createInvite failed");
    expect(first.invite.role).toBe("viewer");
    expect(again.invite.role).toBe("viewer");
  });

  it("accepting makes a new member a viewer", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const guest = await makeAccount(db, "guest");
    const email = await emailOf(guest.accountId);
    const created = await createInvite(email, server.id, admin.accountId);
    if (!created.invite) throw new Error("createInvite failed");
    expect(await acceptInvite(created.invite.token, { id: guest.accountId, email })).toEqual({ ok: true, serverId: server.id });
    expect(await roleOf(server.id, guest.accountId)).toBe("viewer");
  });

  it("accepting an invite never changes the role of someone who is already a member, admin included", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const email = await emailOf(admin.accountId);
    const created = await createInvite(email, server.id, admin.accountId);
    if (!created.invite) throw new Error("createInvite failed");
    expect((await acceptInvite(created.invite.token, { id: admin.accountId, email })).ok).toBe(true);
    expect(await roleOf(server.id, admin.accountId)).toBe("admin"); // not demoted
  });
});

describe("database guarantees", () => {
  it("refuses a second admin on a server, but allows one admin per server", async () => {
    const a = await makeAccount(db, "a");
    const b = await makeAccount(db, "b");
    const server = await makeServer(db, a.accountId);
    await expect(joinServer(db, server.id, b.accountId, "admin")).rejects.toThrow();
    await joinServer(db, server.id, b.accountId, "viewer");
    expect(await roleOf(server.id, b.accountId)).toBe("viewer");
    // Promoting a second member to admin is refused too.
    await expect(db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.profileId, b.accountId)))).rejects.toThrow();
    // A different server can have its own admin.
    const other = await makeServer(db, b.accountId);
    expect(await roleOf(other.id, b.accountId)).toBe("admin");
  });

  it("refuses an admin invite", async () => {
    const a = await makeAccount(db, "a");
    const server = await makeServer(db, a.accountId);
    await expect(
      db.insert(invites).values({ serverId: server.id, email: "x@y.z", role: "admin", token: `t-${Math.random()}`, expiresAt: new Date(Date.now() + 1000) })
    ).rejects.toThrow();
  });
});
