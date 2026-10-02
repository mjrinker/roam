/**
 * The playlist hooks on the profile routes, run through the REAL handlers against
 * an in-memory Postgres (pglite). Only the login lookup and the cookie jar are
 * faked. Covers: deleting a profile cleans up its playlists, and turning off
 * "visible on server" removes that profile's access to other accounts' playlists.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
}));

vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: () => undefined, get: () => undefined }) }));

import { playlistMembers, playlists, profiles, viewers } from "@/lib/db/schema";
import { addMember, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeViewer } from "@/lib/playlists/test-db";
import { DELETE, PATCH } from "./route";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const json = (body: unknown) =>
  new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Signs in as `viewerId` of `accountId` (loading the account's real rows). */
async function signInAs(accountId: string, viewerId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === viewerId), viewers: all };
}

const countOf = async (table: typeof playlists | typeof playlistMembers, col: unknown, id: string) =>
  (await db.select().from(table).where(eq(col as never, id))).length;

beforeEach(() => {
  h.resolution = null;
});

describe("DELETE /api/viewers/[id]", () => {
  it("deletes the profile's unshared private playlists and leaves shared ones ownerless", async () => {
    const owner = await makeAccount(db, "owner");
    const server = await makeServer(db, owner.accountId);
    const kid = await makeViewer(db, owner.accountId, { role: "limited" });
    const guest = await makeAccount(db, "guest");
    await joinServer(db, server.id, guest.accountId);

    const unshared = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const shared = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    await addMember(db, shared.id, guest.viewer.id, "viewer", kid.id);

    await signInAs(owner.accountId, owner.viewer.id);
    const res = await DELETE(new Request("http://x/api", { method: "DELETE" }), ctx(kid.id));
    expect(res.status).toBe(200);

    expect(await countOf(playlists, playlists.id, unshared.id)).toBe(0);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, shared.id));
    expect(row.ownerViewerId).toBeNull();
  });

  it("collects an ownerless private playlist whose last member was the deleted profile", async () => {
    const owner = await makeAccount(db, "owner");
    const server = await makeServer(db, owner.accountId);
    const doomed = await makeViewer(db, owner.accountId, { role: "limited" });
    const lonely = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await addMember(db, lonely.id, doomed.id);

    await signInAs(owner.accountId, owner.viewer.id);
    expect((await DELETE(new Request("http://x/api", { method: "DELETE" }), ctx(doomed.id))).status).toBe(200);
    expect(await countOf(playlists, playlists.id, lonely.id)).toBe(0);
  });

  it("still refuses to delete the owner profile and writes nothing", async () => {
    const owner = await makeAccount(db, "owner");
    const server = await makeServer(db, owner.accountId);
    await makeViewer(db, owner.accountId); // so it isn't "the last profile"
    const mine = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await signInAs(owner.accountId, owner.viewer.id);
    const res = await DELETE(new Request("http://x/api", { method: "DELETE" }), ctx(owner.viewer.id));
    expect(res.status).toBe(400);
    expect(await countOf(playlists, playlists.id, mine.id)).toBe(1);
  });
});

describe("PATCH /api/viewers/[id] — visibleOnServer", () => {
  async function scenario() {
    const host = await makeAccount(db, "host");
    const server = await makeServer(db, host.accountId);
    const hider = await makeAccount(db, "hider");
    await joinServer(db, server.id, hider.accountId);
    const sibling = await makeViewer(db, hider.accountId);
    const foreign = await makePlaylist(db, { serverId: server.id, ownerViewerId: host.viewer.id });
    await addMember(db, foreign.id, hider.viewer.id);
    const sameAccount = await makePlaylist(db, { serverId: server.id, ownerViewerId: sibling.id });
    await addMember(db, sameAccount.id, hider.viewer.id);
    await makeLibrary(db, server.id);
    await signInAs(hider.accountId, hider.viewer.id);
    return { hider, foreign, sameAccount };
  }

  it("turning visibility off removes access to other accounts' playlists, not sibling-account ones", async () => {
    const { hider, foreign, sameAccount } = await scenario();
    const res = await PATCH(json({ visibleOnServer: false }), ctx(hider.viewer.id));
    expect(res.status).toBe(200);
    expect(await countOf(playlistMembers, playlistMembers.playlistId, foreign.id)).toBe(0);
    expect(await countOf(playlistMembers, playlistMembers.playlistId, sameAccount.id)).toBe(1);
    const [v] = await db.select().from(viewers).where(eq(viewers.id, hider.viewer.id));
    expect(v.visibleOnServer).toBe(false);
  });

  it("turning visibility on, or changing something else, revokes nothing", async () => {
    const { hider, foreign } = await scenario();
    expect((await PATCH(json({ visibleOnServer: true }), ctx(hider.viewer.id))).status).toBe(200);
    expect((await PATCH(json({ name: "Renamed" }), ctx(hider.viewer.id))).status).toBe(200);
    expect(await countOf(playlistMembers, playlistMembers.playlistId, foreign.id)).toBe(1);
  });

  it("makes no change when the request is invalid", async () => {
    const { hider, foreign } = await scenario();
    const res = await PATCH(json({ visibleOnServer: "nope" }), ctx(hider.viewer.id));
    expect(res.status).toBe(400);
    expect(await countOf(playlistMembers, playlistMembers.playlistId, foreign.id)).toBe(1);
  });
});
