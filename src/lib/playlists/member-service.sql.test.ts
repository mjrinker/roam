/** Sharing, transfer, the share picker and the moderation list, on a real in-memory Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { playlistMembers, playlists, viewers } from "@/lib/db/schema";
import { addMember, changeMemberRole, listMembers, listPublicForAdmin, removeMember, sharePicker, transferOwnership } from "./member-service";
import {
  addMember as seedMember,
  createTestDb,
  joinServer,
  makeAccount,
  makePlaylist,
  makeServer,
  makeViewer,
  type TestDb,
} from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const friend = await makeAccount(db, "friend");
  await joinServer(db, server.id, friend.accountId);
  const stranger = await makeAccount(db, "stranger"); // not on the server
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
  return { owner, server, friend, stranger, playlist };
}

const roleOf = async (playlistId: string, viewerId: string) =>
  (await db.select().from(playlistMembers).where(and(eq(playlistMembers.playlistId, playlistId), eq(playlistMembers.viewerId, viewerId))))[0]?.role ?? null;

describe("addMember", () => {
  it("lets the owner share as editor, sharer or viewer, and change an existing share by sharing again", async () => {
    const { owner, friend, playlist } = await world();
    expect(await addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id, role: "viewer" })).toMatchObject({ ok: true });
    expect(await roleOf(playlist.id, friend.viewer.id)).toBe("viewer");
    await addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id, role: "editor" });
    expect(await roleOf(playlist.id, friend.viewer.id)).toBe("editor");
  });

  it("a sharer may only grant viewer, and never overwrites an existing share", async () => {
    const { owner, friend, playlist } = await world();
    const third = await makeAccount(db, "third");
    await joinServer(db, playlist.serverId, third.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "sharer", owner.viewer.id);
    await seedMember(db, playlist.id, third.viewer.id, "editor", owner.viewer.id);
    const sibling = await makeViewer(db, friend.accountId);

    expect(await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: sibling.id, role: "editor" })).toMatchObject({ ok: false, status: 403 });
    expect(await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: sibling.id, role: "viewer" })).toMatchObject({ ok: true });
    // Re-sharing the editor as "viewer" does nothing: no downgrade.
    await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: third.viewer.id, role: "viewer" });
    expect(await roleOf(playlist.id, third.viewer.id)).toBe("editor");
  });

  it("is 403 for editors and viewers", async () => {
    const { owner, friend, playlist } = await world();
    const third = await makeAccount(db, "third");
    await joinServer(db, playlist.serverId, third.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    expect(await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: third.viewer.id, role: "viewer" })).toMatchObject({ ok: false, status: 403 });
  });

  it("answers an identical 404 for every invalid target", async () => {
    const { owner, friend, stranger, playlist } = await world();
    await db.update(viewers).set({ visibleOnServer: false }).where(eq(viewers.id, friend.viewer.id));
    const results = await Promise.all([
      addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: "00000000-0000-4000-8000-0000000000aa", role: "viewer" }), // doesn't exist
      addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: stranger.viewer.id, role: "viewer" }), // not on the server
      addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id, role: "viewer" }), // hides itself
      addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: owner.viewer.id, role: "viewer" }), // yourself / the owner
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, status: 404, error: "Not found" });
  });

  it("allows sharing with a hidden profile on the SAME account", async () => {
    const { owner, playlist } = await world();
    const sibling = await makeViewer(db, owner.accountId, { visibleOnServer: false });
    expect(await addMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: sibling.id, role: "viewer" })).toMatchObject({ ok: true });
  });

  it("a limited owner can share only within their own account", async () => {
    const { server, friend } = await world();
    const acct = await makeAccount(db, "family");
    await joinServer(db, server.id, acct.accountId);
    const kid = await makeViewer(db, acct.accountId, { role: "limited" });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    expect(await addMember(db, { playlistId: p.id, viewerId: kid.id, targetViewerId: friend.viewer.id, role: "viewer" })).toMatchObject({ ok: false, status: 403 });
    expect(await addMember(db, { playlistId: p.id, viewerId: kid.id, targetViewerId: acct.viewer.id, role: "viewer" })).toMatchObject({ ok: true });
  });

  it("an ownerless playlist accepts no new shares", async () => {
    const { friend, playlist } = await world();
    await db.update(playlists).set({ ownerViewerId: null }).where(eq(playlists.id, playlist.id));
    const third = await makeAccount(db, "third");
    await joinServer(db, playlist.serverId, third.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "sharer");
    expect(await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: third.viewer.id, role: "viewer" })).toMatchObject({ ok: false, status: 403 });
  });

  it("is 404 for someone who can't see the playlist", async () => {
    const { friend, playlist } = await world();
    const third = await makeAccount(db, "third");
    await joinServer(db, playlist.serverId, third.accountId);
    expect(await addMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: third.viewer.id, role: "viewer" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("changeMemberRole", () => {
  it("only the owner can change a role", async () => {
    const { owner, friend, playlist } = await world();
    const third = await makeAccount(db, "third");
    await joinServer(db, playlist.serverId, third.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    await seedMember(db, playlist.id, third.viewer.id, "viewer", owner.viewer.id);
    expect(await changeMemberRole(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: third.viewer.id, role: "editor" })).toMatchObject({ ok: false, status: 403 });
    expect(await changeMemberRole(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: third.viewer.id, role: "editor" })).toMatchObject({ ok: true });
    expect(await roleOf(playlist.id, third.viewer.id)).toBe("editor");
    expect(await changeMemberRole(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: "00000000-0000-4000-8000-0000000000bb", role: "editor" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("removeMember", () => {
  it("anyone may leave; the owner may remove anyone; a sharer only viewer shares they granted", async () => {
    const { owner, friend, playlist } = await world();
    const a = await makeAccount(db, "a");
    const b = await makeAccount(db, "b");
    await joinServer(db, playlist.serverId, a.accountId);
    await joinServer(db, playlist.serverId, b.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "sharer", owner.viewer.id);
    await seedMember(db, playlist.id, a.viewer.id, "viewer", friend.viewer.id); // granted by the sharer
    await seedMember(db, playlist.id, b.viewer.id, "viewer", owner.viewer.id); // granted by the owner

    expect(await removeMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: b.viewer.id })).toMatchObject({ ok: false, status: 404 });
    expect(await removeMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: a.viewer.id })).toMatchObject({ ok: true });
    expect(await removeMember(db, { playlistId: playlist.id, viewerId: b.viewer.id, targetViewerId: b.viewer.id })).toMatchObject({ ok: true }); // leave
    expect(await removeMember(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id })).toMatchObject({ ok: true });
    expect(await roleOf(playlist.id, friend.viewer.id)).toBeNull();
  });

  it("an editor can't revoke others (answers 404) but can leave", async () => {
    const { owner, friend, playlist } = await world();
    const other = await makeAccount(db, "other");
    await joinServer(db, playlist.serverId, other.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    await seedMember(db, playlist.id, other.viewer.id, "viewer", owner.viewer.id);
    expect(await removeMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: other.viewer.id })).toMatchObject({ ok: false, status: 404 });
    expect(await removeMember(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: friend.viewer.id })).toMatchObject({ ok: true });
  });

  it("leaving an ownerless private playlist as its last member collects it", async () => {
    const { friend, server } = await world();
    const lonely = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await seedMember(db, lonely.id, friend.viewer.id, "viewer");
    expect(await removeMember(db, { playlistId: lonely.id, viewerId: friend.viewer.id, targetViewerId: friend.viewer.id })).toMatchObject({ ok: true });
    expect(await db.select().from(playlists).where(eq(playlists.id, lonely.id))).toHaveLength(0);
  });

  it("on an ownerless playlist members can still leave but nobody can revoke", async () => {
    const { friend, server } = await world();
    const other = await makeAccount(db, "other");
    await joinServer(db, server.id, other.accountId);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await seedMember(db, p.id, friend.viewer.id, "viewer");
    await seedMember(db, p.id, other.viewer.id, "viewer");
    expect(await removeMember(db, { playlistId: p.id, viewerId: friend.viewer.id, targetViewerId: other.viewer.id })).toMatchObject({ ok: false, status: 404 });
    expect(await removeMember(db, { playlistId: p.id, viewerId: friend.viewer.id, targetViewerId: friend.viewer.id })).toMatchObject({ ok: true });
  });
});

describe("listMembers", () => {
  it("owner and editors see everyone, a sharer sees own plus granted, a viewer only their own", async () => {
    const { owner, friend, playlist } = await world();
    const a = await makeAccount(db, "a");
    const b = await makeAccount(db, "b");
    const c = await makeAccount(db, "c");
    for (const x of [a, b, c]) await joinServer(db, playlist.serverId, x.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "sharer", owner.viewer.id);
    await seedMember(db, playlist.id, a.viewer.id, "viewer", friend.viewer.id);
    await seedMember(db, playlist.id, b.viewer.id, "viewer", owner.viewer.id);
    await seedMember(db, playlist.id, c.viewer.id, "editor", owner.viewer.id);

    const ids = async (viewerId: string) => {
      const r = await listMembers(db, { playlistId: playlist.id, viewerId });
      return r.ok ? r.value.members.map((m) => m.id).sort() : [];
    };
    expect(await ids(owner.viewer.id)).toEqual([a.viewer.id, b.viewer.id, c.viewer.id, friend.viewer.id].sort());
    expect(await ids(c.viewer.id)).toEqual([a.viewer.id, b.viewer.id, c.viewer.id, friend.viewer.id].sort());
    expect(await ids(friend.viewer.id)).toEqual([a.viewer.id, friend.viewer.id].sort());
    expect(await ids(b.viewer.id)).toEqual([b.viewer.id]);
  });

  it("flags the shares the asking viewer granted", async () => {
    const { owner, friend, playlist } = await world();
    const a = await makeAccount(db, "a");
    await joinServer(db, playlist.serverId, a.accountId);
    await seedMember(db, playlist.id, friend.viewer.id, "sharer", owner.viewer.id);
    await seedMember(db, playlist.id, a.viewer.id, "viewer", friend.viewer.id);
    const asSharer = await listMembers(db, { playlistId: playlist.id, viewerId: friend.viewer.id });
    const granted = asSharer.ok ? Object.fromEntries(asSharer.value.members.map((m) => [m.id, m.grantedByMe])) : {};
    expect(granted).toEqual({ [friend.viewer.id]: false, [a.viewer.id]: true });
  });

  it("masks a hidden profile for readers on other accounts only", async () => {
    const { owner, friend, playlist } = await world();
    await db.update(viewers).set({ visibleOnServer: false, name: "Secret Name" }).where(eq(viewers.id, friend.viewer.id));
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    const asOwner = await listMembers(db, { playlistId: playlist.id, viewerId: owner.viewer.id });
    expect(asOwner.ok && asOwner.value.members[0]).toMatchObject({ name: "Profile", role: "editor" });
    const asSelf = await listMembers(db, { playlistId: playlist.id, viewerId: friend.viewer.id });
    expect(asSelf.ok && asSelf.value.members[0]).toMatchObject({ name: "Secret Name", isMe: true });
  });

  it("paginates with a cursor", async () => {
    const { owner, playlist } = await world();
    for (let i = 0; i < 3; i++) {
      const x = await makeAccount(db, `m${i}`);
      await joinServer(db, playlist.serverId, x.accountId);
      await seedMember(db, playlist.id, x.viewer.id, "viewer", owner.viewer.id);
    }
    const first = await listMembers(db, { playlistId: playlist.id, viewerId: owner.viewer.id, limit: 2 });
    expect(first.ok && first.value.members).toHaveLength(2);
    const second = await listMembers(db, { playlistId: playlist.id, viewerId: owner.viewer.id, limit: 2, after: first.ok ? first.value.nextCursor : null });
    expect(second.ok && second.value.members).toHaveLength(1);
  });
});

describe("transferOwnership", () => {
  it("hands the playlist to a member and demotes the old owner to editor", async () => {
    const { owner, friend, playlist } = await world();
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    expect(await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id })).toMatchObject({ ok: true });
    const [row] = await db.select().from(playlists).where(eq(playlists.id, playlist.id));
    expect(row.ownerViewerId).toBe(friend.viewer.id);
    expect(await roleOf(playlist.id, friend.viewer.id)).toBeNull(); // the owner has no member row
    expect(await roleOf(playlist.id, owner.viewer.id)).toBe("editor");
  });

  it("only the owner may transfer", async () => {
    const { owner, friend, playlist } = await world();
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    expect(await transferOwnership(db, { playlistId: playlist.id, viewerId: friend.viewer.id, targetViewerId: owner.viewer.id })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses targets without a share, outside the server, limited, or yourself — all as 404", async () => {
    const { owner, friend, stranger, playlist } = await world();
    const acct = await makeAccount(db, "family");
    await joinServer(db, playlist.serverId, acct.accountId);
    const kid = await makeViewer(db, acct.accountId, { role: "limited" });
    await seedMember(db, playlist.id, kid.id, "editor", owner.viewer.id);
    await seedMember(db, playlist.id, stranger.viewer.id, "editor", owner.viewer.id);
    for (const target of [friend.viewer.id, stranger.viewer.id, kid.id, owner.viewer.id]) {
      expect(await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: target })).toEqual({ ok: false, status: 404, error: "Not found" });
    }
  });

  it("doesn't leave a hidden old owner with access when the new owner is on another account", async () => {
    const { owner, friend, playlist } = await world();
    await db.update(viewers).set({ visibleOnServer: false }).where(eq(viewers.id, owner.viewer.id));
    await seedMember(db, playlist.id, friend.viewer.id, "editor", owner.viewer.id);
    await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: friend.viewer.id });
    expect(await roleOf(playlist.id, owner.viewer.id)).toBeNull();
  });
});

describe("sharePicker", () => {
  it("offers other members' opted-in profiles plus own siblings, never hidden others or non-members", async () => {
    const { owner, server, friend, stranger } = await world();
    const hidden = await makeAccount(db, "hidden");
    await joinServer(db, server.id, hidden.accountId);
    await db.update(viewers).set({ visibleOnServer: false }).where(eq(viewers.id, hidden.viewer.id));
    const sibling = await makeViewer(db, owner.accountId, { visibleOnServer: false });
    const r = await sharePicker(db, { serverId: server.id, viewerId: owner.viewer.id });
    const ids = r.ok ? r.value.viewers.map((v) => v.id) : [];
    expect(ids).toContain(friend.viewer.id);
    expect(ids).toContain(sibling.id);
    expect(ids).not.toContain(hidden.viewer.id);
    expect(ids).not.toContain(stranger.viewer.id);
    expect(ids).not.toContain(owner.viewer.id);
    expect(Object.keys(r.ok ? r.value.viewers[0] : {}).sort()).toEqual(["avatarKey", "id", "name"]);
  });

  it("limited profiles only see their own account's other profiles", async () => {
    const { server, friend } = await world();
    const acct = await makeAccount(db, "family");
    await joinServer(db, server.id, acct.accountId);
    const kid = await makeViewer(db, acct.accountId, { role: "limited" });
    const r = await sharePicker(db, { serverId: server.id, viewerId: kid.id });
    const ids = r.ok ? r.value.viewers.map((v) => v.id) : [];
    expect(ids).toEqual([acct.viewer.id]);
    expect(ids).not.toContain(friend.viewer.id);
  });

  it("is a 404 for someone who isn't on the server, and paginates", async () => {
    const { owner, server, stranger } = await world();
    expect(await sharePicker(db, { serverId: server.id, viewerId: stranger.viewer.id })).toMatchObject({ ok: false, status: 404 });
    for (let i = 0; i < 3; i++) {
      const x = await makeAccount(db, `p${i}`);
      await joinServer(db, server.id, x.accountId);
    }
    const first = await sharePicker(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 2 });
    expect(first.ok && first.value.nextCursor).not.toBeNull();
    const second = await sharePicker(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 100, after: first.ok ? first.value.nextCursor : null });
    expect(second.ok && second.value.viewers.length).toBeGreaterThan(0);
  });
});

describe("listPublicForAdmin", () => {
  it("lists public playlists for a server admin only", async () => {
    const { owner, server, friend } = await world();
    await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, visibility: "server", name: "Public one" });
    await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, name: "Private one" });
    const asAdmin = await listPublicForAdmin(db, { serverId: server.id, viewerId: owner.viewer.id });
    expect(asAdmin.ok && asAdmin.value.playlists.map((p) => p.name)).toEqual(["Public one"]);
    expect(await listPublicForAdmin(db, { serverId: server.id, viewerId: friend.viewer.id })).toMatchObject({ ok: false, status: 404 });
    const limitedAdmin = await makeViewer(db, owner.accountId, { role: "limited" });
    expect(await listPublicForAdmin(db, { serverId: server.id, viewerId: limitedAdmin.id })).toMatchObject({ ok: false, status: 404 });
  });

  it("paginates with a cursor", async () => {
    const { owner, server, friend } = await world();
    for (const name of ["a", "b", "c"]) await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, visibility: "server", name });
    const first = await listPublicForAdmin(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 2 });
    expect(first.ok && first.value.playlists.map((p) => p.name)).toEqual(["a", "b"]);
    const second = await listPublicForAdmin(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 2, after: first.ok ? first.value.nextCursor : null });
    expect(second.ok && second.value.playlists.map((p) => p.name)).toEqual(["c"]);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });
});
