/** Which invitations an admin sees, and deleting one. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { invites, profiles, serverMembers, viewers } from "@/lib/db/schema";
import { DELETE } from "@/app/api/invites/[id]/route";
import { listInvitesForAdmin } from "./invites";
import { joinServer, makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const invite = (serverId: string, email: string, expiresInDays: number, over: Partial<typeof invites.$inferInsert> = {}) =>
  db.insert(invites).values({ serverId, email, token: `tok${++n}${Math.random()}`, expiresAt: new Date(Date.now() + expiresInDays * DAY), ...over }).returning().then((r) => r[0]);

describe("the invitations an admin sees", () => {
  it("lists pending ones and ones that expired within the last week, hides ones expired longer ago, and keeps accepted ones", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const other = await makeServer(db, owner.accountId);
    await invite(server.id, "pending@example.com", 5);
    await invite(server.id, "just-expired@example.com", -2);
    await invite(server.id, "nearly-a-week@example.com", -6.5);
    await invite(server.id, "long-expired@example.com", -8);
    await invite(server.id, "accepted-long-ago@example.com", -30, { acceptedAt: new Date(Date.now() - 31 * DAY) });
    await invite(other.id, "other-server@example.com", 5);
    const emails = (await listInvitesForAdmin(server.id)).map((i) => i.email).sort();
    expect(emails).toEqual(["accepted-long-ago@example.com", "just-expired@example.com", "nearly-a-week@example.com", "pending@example.com"]);
    // the hidden one is still in the database: nothing deletes it
    expect(await db.select().from(invites).where(eq(invites.email, "long-expired@example.com"))).toHaveLength(1);
  });
  it("judges 'a week' from the time it is asked", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    await invite(server.id, "lapsed@example.com", -6);
    expect((await listInvitesForAdmin(server.id)).map((i) => i.email)).toEqual(["lapsed@example.com"]);
    expect(await listInvitesForAdmin(server.id, new Date(Date.now() + 2 * DAY))).toEqual([]);
  });
});

describe("DELETE /api/invites/[id]", () => {
  const ask = (id: string) => DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id }) } as never);
  it("deletes a pending invitation for the server's admin, leaving an accepted invitation's member in place", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const joined = await makeAccount(db, "joined");
    await joinServer(db, server.id, joined.accountId);
    const pending = await invite(server.id, "p@example.com", 3);
    const accepted = await invite(server.id, "a@example.com", 3, { acceptedAt: new Date() });
    await signInAs(admin.accountId);
    expect((await ask(pending.id)).status).toBe(200);
    expect((await ask(accepted.id)).status).toBe(200);
    expect(await db.select().from(invites).where(eq(invites.serverId, server.id))).toEqual([]);
    expect(await db.select().from(serverMembers).where(eq(serverMembers.profileId, joined.accountId))).toHaveLength(1);
    expect((await ask(pending.id)).status).toBe(404);
  });
  it("is a 404 for anyone but the server's admin, and for a bad id", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const member = await makeAccount(db, "member");
    await joinServer(db, server.id, member.accountId);
    const stranger = await makeAccount(db, "stranger");
    const inv = await invite(server.id, "x@example.com", 3);
    for (const who of [member, stranger]) {
      await signInAs(who.accountId);
      expect((await ask(inv.id)).status).toBe(404);
    }
    expect((await ask("not-an-id")).status).toBe(404);
    expect(await db.select().from(invites).where(eq(invites.id, inv.id))).toHaveLength(1);
  });
});
