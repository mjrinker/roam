/** Library sharing on a real in-memory Postgres: who sees a restricted library, in every reader, and the database guarantees. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { libraries, libraryMembers, serverMembers } from "@/lib/db/schema";
import { canSeeLibrary, libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { addItem as addPlaylistItem, listItems } from "@/lib/playlists/item-service";
import { listEditablePlaylistsForItem } from "@/lib/playlists/for-item";
import { nextAfter } from "@/lib/playlists/next";
import { copyPlaylist, createPlaylist, getPlaylistDetail } from "@/lib/playlists/service";
import { getLibraryAccess, setLibraryAccess } from "./access-service";
import {
  addItem,
  createTestDb,
  joinServer,
  makeAccount,
  makeLibrary,
  makePlaylist,
  makeServer,
  makeTitle,
  type TestDb,
} from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

/** A server with an admin, a granted member, an ungranted member and an outsider; one restricted and one open library. */
async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const granted = await makeAccount(db, "granted");
  const plain = await makeAccount(db, "plain");
  const outsider = await makeAccount(db, "outsider");
  await joinServer(db, server.id, granted.accountId);
  await joinServer(db, server.id, plain.accountId);
  const secret = await makeLibrary(db, server.id, "movies", "restricted");
  const open = await makeLibrary(db, server.id, "movies", "everyone");
  await db.insert(libraryMembers).values({ libraryId: secret.id, serverId: server.id, accountId: granted.accountId });
  const secretTitle = await makeTitle(db, secret.id, { name: "Secret" });
  const openTitle = await makeTitle(db, open.id, { name: "Open" });
  // A public playlist (visible to the whole server) holding both.
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: admin.viewer.id, visibility: "server" });
  const s = await addItem(db, playlist.id, { titleId: secretTitle.id }, 1024);
  const o = await addItem(db, playlist.id, { titleId: openTitle.id }, 2048);
  const actor = (acct: { accountId: string }, isAdmin = false): LibraryActor => ({ serverId: server.id, accountId: acct.accountId, isAdmin });
  return { admin, server, granted, plain, outsider, secret, open, secretTitle, openTitle, playlist, secretItem: s, openItem: o, actor };
}

const names = async (viewerId: string, playlistId: string) => {
  const r = await listItems(db, { playlistId, viewerId });
  if (!r.ok) throw new Error("listItems failed");
  return r.value.items.map((i) => i.name);
};

describe("libraryVisible / canSeeLibrary", () => {
  it("shows a restricted library to a server admin and a granted account, not to an ungranted one", async () => {
    const w = await world();
    expect(await canSeeLibrary(db, w.actor(w.admin, true), w.secret.id)).toBe(true);
    expect(await canSeeLibrary(db, w.actor(w.granted), w.secret.id)).toBe(true);
    expect(await canSeeLibrary(db, w.actor(w.plain), w.secret.id)).toBe(false);
    expect(await canSeeLibrary(db, w.actor(w.plain), w.open.id)).toBe(true);
  });

  it("never reaches another server's library, even for an admin", async () => {
    const w = await world();
    const other = await makeServer(db, (await makeAccount(db, "other")).accountId);
    const foreign = await makeLibrary(db, other.id, "movies", "everyone");
    expect(await canSeeLibrary(db, w.actor(w.admin, true), foreign.id)).toBe(false);
    expect(await canSeeLibrary(db, w.actor(w.plain), foreign.id)).toBe(false);
  });

  it("filters a plain query the same way", async () => {
    const w = await world();
    const ids = async (a: LibraryActor) =>
      (await db.select({ id: libraries.id }).from(libraries).where(libraryVisible(db, a))).map((r) => r.id).sort();
    expect(await ids(w.actor(w.plain))).toEqual([w.open.id]);
    expect(await ids(w.actor(w.granted))).toEqual([w.open.id, w.secret.id].sort());
    expect(await ids(w.actor(w.admin, true))).toEqual([w.open.id, w.secret.id].sort());
  });
});

describe("playlists respect library access", () => {
  it("hides items from a restricted library, in lists and counts, from an ungranted account only", async () => {
    const w = await world();
    expect(await names(w.plain.viewer.id, w.playlist.id)).toEqual(["Open"]);
    expect(await names(w.granted.viewer.id, w.playlist.id)).toEqual(["Secret", "Open"]);
    expect(await names(w.admin.viewer.id, w.playlist.id)).toEqual(["Secret", "Open"]);
    const detail = await getPlaylistDetail(db, { playlistId: w.playlist.id, viewerId: w.plain.viewer.id });
    expect(detail.ok && detail.value.itemCount).toBe(1);
  });

  it("revoking access hides it immediately; granting again brings it back", async () => {
    const w = await world();
    await db.delete(libraryMembers).where(and(eq(libraryMembers.libraryId, w.secret.id), eq(libraryMembers.accountId, w.granted.accountId)));
    expect(await names(w.granted.viewer.id, w.playlist.id)).toEqual(["Open"]);
    await db.insert(libraryMembers).values({ libraryId: w.secret.id, serverId: w.server.id, accountId: w.granted.accountId });
    expect(await names(w.granted.viewer.id, w.playlist.id)).toEqual(["Secret", "Open"]);
  });

  it("won't add a hidden title, answers the same 404 as a missing one, and offers no editable-playlist menu for it", async () => {
    const w = await world();
    const mine = await createPlaylist(db, { serverId: w.server.id, viewerId: w.plain.viewer.id, name: "Mine" });
    if (!mine.ok) throw new Error("createPlaylist failed");
    const hidden = await addPlaylistItem(db, { playlistId: mine.value.id, viewerId: w.plain.viewer.id, titleId: w.secretTitle.id });
    const missing = await addPlaylistItem(db, { playlistId: mine.value.id, viewerId: w.plain.viewer.id, titleId: "00000000-0000-4000-8000-0000000000aa" });
    expect(hidden).toEqual(missing);
    expect(hidden).toMatchObject({ ok: false, status: 404 });
    expect((await addPlaylistItem(db, { playlistId: mine.value.id, viewerId: w.plain.viewer.id, titleId: w.openTitle.id })).ok).toBe(true);
    expect(await listEditablePlaylistsForItem(db, { serverId: w.server.id, viewerId: w.plain.viewer.id, titleId: w.secretTitle.id })).toMatchObject({ ok: false, status: 404 });
    // A granted account can add it.
    const theirs = await createPlaylist(db, { serverId: w.server.id, viewerId: w.granted.viewer.id, name: "Theirs" });
    if (!theirs.ok) throw new Error("createPlaylist failed");
    expect((await addPlaylistItem(db, { playlistId: theirs.value.id, viewerId: w.granted.viewer.id, titleId: w.secretTitle.id })).ok).toBe(true);
  });

  it("skips hidden items when asked what plays next, and treats a cursor at a hidden item as not found", async () => {
    const w = await world();
    // Order: secret(1024), open(2048). After "nothing" the first visible item is Open for the ungranted account.
    const first = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.plain.viewer.id });
    expect(first.ok && first.value?.itemId).toBe(w.openItem.id);
    const forGranted = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.granted.viewer.id });
    expect(forGranted.ok && forGranted.value?.itemId).toBe(w.secretItem.id);
    expect(await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.plain.viewer.id, afterItemId: w.secretItem.id })).toMatchObject({ ok: false, status: 404 });
  });

  it("copies only what the copier may see", async () => {
    const w = await world();
    const r = await copyPlaylist(db, { playlistId: w.playlist.id, viewerId: w.plain.viewer.id });
    expect(r.ok && r.value.itemsCopied).toBe(1);
    const g = await copyPlaylist(db, { playlistId: w.playlist.id, viewerId: w.granted.viewer.id });
    expect(g.ok && g.value.itemsCopied).toBe(2);
  });
});

describe("access service", () => {
  it("lists every account on the server with who has an explicit grant", async () => {
    const w = await world();
    const view = await getLibraryAccess(db, w.secret.id);
    expect(view?.access).toBe("restricted");
    expect(view?.people.map((p) => [p.name, p.isAdmin, p.granted]).sort()).toEqual([
      ["admin", true, false],
      ["granted", false, true],
      ["plain", false, false],
    ]);
    expect(await getLibraryAccess(db, "00000000-0000-4000-8000-0000000000bb")).toBeNull();
  });

  it("applies a grant/revoke diff, skips admins, leaves untouched accounts alone, and keeps grants when switched to everyone", async () => {
    const w = await world();
    const set = await setLibraryAccess(db, {
      libraryId: w.secret.id,
      actorAccountId: w.admin.accountId,
      access: "restricted",
      grant: [w.plain.accountId, w.admin.accountId],
      revoke: [],
    });
    expect(set).toEqual({ ok: true });
    expect(await canSeeLibrary(db, w.actor(w.plain), w.secret.id)).toBe(true);
    expect(await canSeeLibrary(db, w.actor(w.granted), w.secret.id)).toBe(true); // not mentioned: unchanged
    const rows = await db.select().from(libraryMembers).where(eq(libraryMembers.libraryId, w.secret.id));
    expect(rows.map((r) => r.accountId).sort()).toEqual([w.granted.accountId, w.plain.accountId].sort()); // the admin wasn't stored

    await setLibraryAccess(db, { libraryId: w.secret.id, actorAccountId: w.admin.accountId, access: "restricted", grant: [], revoke: [w.granted.accountId] });
    expect(await canSeeLibrary(db, w.actor(w.granted), w.secret.id)).toBe(false);

    await setLibraryAccess(db, { libraryId: w.secret.id, actorAccountId: w.admin.accountId, access: "everyone", grant: [], revoke: [] });
    expect(await canSeeLibrary(db, w.actor(w.granted), w.secret.id)).toBe(true); // open to all now
    expect((await db.select().from(libraryMembers).where(eq(libraryMembers.libraryId, w.secret.id))).length).toBe(1); // plain's grant kept
  });

  it("refuses accounts that aren't on the library's server, and a missing library", async () => {
    const w = await world();
    const r = await setLibraryAccess(db, { libraryId: w.secret.id, actorAccountId: w.admin.accountId, access: "restricted", grant: [w.outsider.accountId], revoke: [] });
    expect(r).toEqual({ ok: false, reason: "not_members" });
    expect((await db.select().from(libraryMembers).where(eq(libraryMembers.libraryId, w.secret.id))).map((x) => x.accountId)).toEqual([w.granted.accountId]); // unchanged
    expect(await setLibraryAccess(db, { libraryId: "00000000-0000-4000-8000-0000000000bb", actorAccountId: w.admin.accountId, access: "restricted", grant: [], revoke: [] })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("database guarantees", () => {
  it("rejects a grant for an account that isn't a member of the library's server", async () => {
    const w = await world();
    await expect(db.insert(libraryMembers).values({ libraryId: w.secret.id, serverId: w.server.id, accountId: w.outsider.accountId })).rejects.toThrow();
  });

  it("rejects a grant whose server doesn't match the library's server", async () => {
    const w = await world();
    const other = await makeServer(db, (await makeAccount(db, "o2")).accountId);
    await joinServer(db, other.id, w.plain.accountId);
    await expect(db.insert(libraryMembers).values({ libraryId: w.secret.id, serverId: other.id, accountId: w.plain.accountId })).rejects.toThrow();
  });

  it("removes grants when the account leaves the server or the library is deleted", async () => {
    const w = await world();
    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.profileId, w.granted.accountId)));
    expect((await db.select().from(libraryMembers).where(eq(libraryMembers.libraryId, w.secret.id))).length).toBe(0);

    const w2 = await world();
    await db.delete(libraries).where(eq(libraries.id, w2.secret.id));
    expect((await db.select().from(libraryMembers).where(eq(libraryMembers.libraryId, w2.secret.id))).length).toBe(0);
  });

  it("a library inserted without saying otherwise is restricted", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const [lib] = await db.insert(libraries).values({ serverId: server.id, name: "x", kind: "movies", boxFolderId: `bf-${Math.random()}` }).returning();
    expect(lib.access).toBe("restricted");
  });
});
