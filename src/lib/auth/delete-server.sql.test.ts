/** Deleting a server removes all of it and nothing of another server or any account. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { invites, libraries, mediaFiles, playlists, profiles, serverMembers, servers, storageConnections, titles, viewers, watchState } from "@/lib/db/schema";
import { DELETE } from "@/app/api/servers/[serverId]/route";
import { deleteServer } from "./delete-server";
import { joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}

async function populate(owner: Awaited<ReturnType<typeof makeAccount>>, member?: Awaited<ReturnType<typeof makeAccount>>) {
  const server = await makeServer(db, owner.accountId);
  if (member) await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, lib.id, { kind: "movie", name: "Film" });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, partIndex: 0, boxFileId: `f${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 5 });
  await db.insert(watchState).values({ viewerId: owner.viewer.id, ownerKind: "title", ownerId: film.id, positionSeconds: 3 });
  await db.insert(storageConnections).values({ serverId: server.id, provider: "dropbox", label: "Dropbox" });
  await db.insert(invites).values({ serverId: server.id, email: "x@example.com", token: `t${Math.random()}`, expiresAt: new Date(Date.now() + 1e9) });
  await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
  return { server, lib, film };
}

describe("deleting a server", () => {
  it("removes its libraries, items, files, history, connections, invitations, playlists and members, and leaves another server and every account alone", async () => {
    const owner = await makeAccount(db, "o");
    const member = await makeAccount(db, "m");
    const mine = await populate(owner, member);
    const theirs = await populate(owner);

    expect((await deleteServer(mine.server.id)).libraries).toBe(1);

    expect(await db.select().from(servers).where(eq(servers.id, mine.server.id))).toEqual([]);
    expect(await db.select().from(libraries).where(eq(libraries.serverId, mine.server.id))).toEqual([]);
    expect(await db.select().from(titles).where(eq(titles.id, mine.film.id))).toEqual([]);
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, mine.film.id))).toEqual([]);
    expect(await db.select().from(watchState).where(eq(watchState.ownerId, mine.film.id))).toEqual([]);
    for (const table of [storageConnections, invites, playlists, serverMembers]) {
      expect(await db.select().from(table).where(eq(table.serverId, mine.server.id)), String(table)).toEqual([]);
    }

    // the other server is whole
    expect(await db.select().from(servers).where(eq(servers.id, theirs.server.id))).toHaveLength(1);
    expect(await db.select().from(titles).where(eq(titles.id, theirs.film.id))).toHaveLength(1);
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, theirs.film.id))).toHaveLength(1);
    expect(await db.select().from(storageConnections).where(eq(storageConnections.serverId, theirs.server.id))).toHaveLength(1);
    expect(await db.select().from(invites).where(eq(invites.serverId, theirs.server.id))).toHaveLength(1);
    // and so are the accounts
    expect(await db.select().from(profiles).where(eq(profiles.id, member.accountId))).toHaveLength(1);
    expect(await db.select().from(profiles).where(eq(profiles.id, owner.accountId))).toHaveLength(1);
  });
  it("deletes a server with nothing in it", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    expect((await deleteServer(server.id)).libraries).toBe(0);
    expect(await db.select().from(servers).where(eq(servers.id, server.id))).toEqual([]);
  });
});

describe("DELETE /api/servers/[serverId]", () => {
  const ask = (serverId: string, body: unknown) => DELETE(new Request("http://x", { method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ serverId }) } as never);
  it("is for the server's admin only, and needs the server's name", async () => {
    const admin = await makeAccount(db, "admin");
    const member = await makeAccount(db, "member");
    const stranger = await makeAccount(db, "stranger");
    const { server } = await populate(admin, member);
    const [{ name }] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, server.id));

    await signInAs(member.accountId);
    expect((await ask(server.id, { name })).status).toBe(404);
    await signInAs(stranger.accountId);
    expect((await ask(server.id, { name })).status).toBe(404);
    await signInAs(admin.accountId);
    expect((await ask("not-a-uuid", { name })).status).toBe(404);
    expect((await ask(server.id, {})).status).toBe(400);
    expect((await ask(server.id, { name: "nope" })).status).toBe(400);
    expect(await db.select().from(servers).where(eq(servers.id, server.id))).toHaveLength(1);
    const ok = await ask(server.id, { name });
    expect(ok.status).toBe(200);
    expect(await db.select().from(servers).where(eq(servers.id, server.id))).toEqual([]);
    expect((await ask(server.id, { name })).status).toBe(404);
  });
});
