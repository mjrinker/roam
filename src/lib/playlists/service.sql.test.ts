/** Playlist and item operations against a real in-memory Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { playlistItems, playlists, viewers } from "@/lib/db/schema";
import { addItem, listItems, moveItem, removeItem } from "./item-service";
import { listEditablePlaylistsForItem } from "./for-item";
import { copyPlaylist, createPlaylist, deletePlaylist, getPlaylistDetail, listPlaylists, patchPlaylist } from "./service";
import {
  addEpisodeFile,
  addItem as seedItem,
  addMember,
  createTestDb,
  joinServer,
  makeAccount,
  makeLibrary,
  makePlaylist,
  makeServer,
  makeShow,
  makeTitle,
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
  const library = await makeLibrary(db, server.id);
  const guest = await makeAccount(db, "guest");
  await joinServer(db, server.id, guest.accountId);
  return { owner, server, library, guest };
}

const names = async (playlistId: string, viewerId: string) => {
  const r = await listItems(db, { playlistId, viewerId });
  if (!r.ok) throw new Error("list failed");
  return r.value.items.map((i) => i.name);
};
const order = async (playlistId: string) =>
  (await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlistId))).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

describe("createPlaylist", () => {
  it("creates a private playlist owned by the viewer", async () => {
    const { owner, server } = await world();
    const r = await createPlaylist(db, { serverId: server.id, viewerId: owner.viewer.id, name: "Movie night" });
    expect(r.ok && r.value).toMatchObject({ name: "Movie night", visibility: "private", ownerViewerId: owner.viewer.id });
  });

  it("is a 404 for someone whose account isn't on the server", async () => {
    const { server } = await world();
    const outsider = await makeAccount(db, "outsider");
    const r = await createPlaylist(db, { serverId: server.id, viewerId: outsider.viewer.id, name: "x" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe("listPlaylists / getPlaylistDetail", () => {
  it("shows mine, shared-with-me and public ones, never other people's private ones", async () => {
    const { owner, server, guest } = await world();
    const mine = await makePlaylist(db, { serverId: server.id, ownerViewerId: guest.viewer.id, name: "mine" });
    const shared = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "shared" });
    await addMember(db, shared.id, guest.viewer.id, "editor");
    const pub = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, visibility: "server", name: "public" });
    const hidden = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "hidden" });

    const all = await listPlaylists(db, { serverId: server.id, viewerId: guest.viewer.id });
    expect(all.ok && all.value.playlists.map((p) => p.name).sort()).toEqual(["mine", "public", "shared"]);
    const roles = Object.fromEntries((all.ok ? all.value.playlists : []).map((p) => [p.name, p.myRole]));
    expect(roles).toEqual({ mine: "owner", shared: "editor", public: "viewer" });

    for (const [scope, expected] of [["mine", ["mine"]], ["shared", ["shared"]], ["public", ["public"]]] as const) {
      const r = await listPlaylists(db, { serverId: server.id, viewerId: guest.viewer.id, scope });
      expect(r.ok && r.value.playlists.map((p) => p.name)).toEqual(expected);
    }
    expect((await getPlaylistDetail(db, { playlistId: hidden.id, viewerId: guest.viewer.id }))).toMatchObject({ ok: false, status: 404 });
    expect((await getPlaylistDetail(db, { playlistId: pub.id, viewerId: guest.viewer.id })).ok).toBe(true);
    expect(mine.id).toBeTruthy();
  });

  it("counts only items the viewing profile may see, and masks a hidden owner", async () => {
    const { owner, server, library, guest } = await world();
    await db.update(viewers).set({ visibleOnServer: false }).where(eq(viewers.id, owner.viewer.id));
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, visibility: "server", name: "p" });
    await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 0 } })).id }, 1024);
    await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 17 } })).id }, 2048);
    const kid = await makeViewer(db, guest.accountId, { role: "limited", maxAge: 12, allowUnrated: false });

    const forGuestAdult = await listPlaylists(db, { serverId: server.id, viewerId: guest.viewer.id });
    expect(forGuestAdult.ok && forGuestAdult.value.playlists[0]).toMatchObject({ itemCount: 2, owner: { name: "Profile" } });
    const forKid = await listPlaylists(db, { serverId: server.id, viewerId: kid.id });
    expect(forKid.ok && forKid.value.playlists[0].itemCount).toBe(1);
    const ownerSees = await listPlaylists(db, { serverId: server.id, viewerId: owner.viewer.id });
    expect(ownerSees.ok && ownerSees.value.playlists[0].owner?.name).toBe(owner.viewer.name);
  });

  it("paginates with a cursor", async () => {
    const { owner, server } = await world();
    for (let i = 0; i < 3; i++) await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: `p${i}` });
    const first = await listPlaylists(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 2 });
    expect(first.ok && first.value.playlists).toHaveLength(2);
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(cursor).not.toBeNull();
    const second = await listPlaylists(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 2, after: cursor });
    expect(second.ok && second.value.playlists).toHaveLength(1);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });

  it("lazily collects orphaned unshared playlists while listing", async () => {
    const { owner, server } = await world();
    const orphan = await makePlaylist(db, { serverId: server.id, ownerViewerId: null, name: "orphan" });
    await listPlaylists(db, { serverId: server.id, viewerId: owner.viewer.id });
    expect((await db.select().from(playlists).where(eq(playlists.id, orphan.id)))).toHaveLength(0);
  });

  it("detail reports what the viewer may do", async () => {
    const { owner, server, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "sharer");
    const asOwner = await getPlaylistDetail(db, { playlistId: p.id, viewerId: owner.viewer.id });
    expect(asOwner.ok && asOwner.value.can).toMatchObject({ editItems: true, delete: true, transfer: true, makePublic: true });
    const asSharer = await getPlaylistDetail(db, { playlistId: p.id, viewerId: guest.viewer.id });
    expect(asSharer.ok && asSharer.value.can).toMatchObject({ editItems: false, delete: false, leave: true, copy: true, makePublic: false });
    expect(asOwner.ok && asOwner.value.can).toMatchObject({ share: true, grantRoles: ["viewer", "sharer", "editor"], manageMembers: true });
    expect(asSharer.ok && asSharer.value.can).toMatchObject({ share: true, grantRoles: ["viewer"], manageMembers: false });
  });

  it("detail reports no sharing powers for plain members, ownerless playlists, or a limited owner beyond their account", async () => {
    const { owner, server, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "editor");
    const asEditor = await getPlaylistDetail(db, { playlistId: p.id, viewerId: guest.viewer.id });
    expect(asEditor.ok && asEditor.value.can).toMatchObject({ share: false, grantRoles: [], manageMembers: false });

    const ownerless = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await addMember(db, ownerless.id, guest.viewer.id, "sharer");
    const orphan = await getPlaylistDetail(db, { playlistId: ownerless.id, viewerId: guest.viewer.id });
    expect(orphan.ok && orphan.value.can).toMatchObject({ share: false, grantRoles: [], manageMembers: false });

    const kid = await makeViewer(db, guest.accountId, { role: "limited" });
    const kids = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const asKid = await getPlaylistDetail(db, { playlistId: kids.id, viewerId: kid.id });
    expect(asKid.ok && asKid.value.can).toMatchObject({ share: true, makePublic: false });
  });
});

describe("patchPlaylist / deletePlaylist", () => {
  it("lets an editor rename but not change visibility; a viewer can't rename", async () => {
    const { owner, server, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "editor");
    expect(await patchPlaylist(db, { playlistId: p.id, viewerId: guest.viewer.id, name: "New" })).toMatchObject({ ok: true });
    expect(await patchPlaylist(db, { playlistId: p.id, viewerId: guest.viewer.id, visibility: "server" })).toMatchObject({ ok: false, status: 403 });
    const other = await makeAccount(db, "other");
    await joinServer(db, server.id, other.accountId);
    await addMember(db, p.id, other.viewer.id, "viewer");
    expect(await patchPlaylist(db, { playlistId: p.id, viewerId: other.viewer.id, name: "Nope" })).toMatchObject({ ok: false, status: 403 });
  });

  it("a limited profile can take a playlist private but never make it public", async () => {
    const { server } = await world();
    const acct = await makeAccount(db, "family");
    await joinServer(db, server.id, acct.accountId);
    const kid = await makeViewer(db, acct.accountId, { role: "limited" });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id, visibility: "server" });
    expect(await patchPlaylist(db, { playlistId: p.id, viewerId: kid.id, visibility: "private" })).toMatchObject({ ok: true });
    expect(await patchPlaylist(db, { playlistId: p.id, viewerId: kid.id, visibility: "server" })).toMatchObject({ ok: false, status: 403 });
  });

  it("owner deletes; a server admin may delete a public playlist but sees nothing of a private one", async () => {
    const { owner, server, guest } = await world();
    const pub = await makePlaylist(db, { serverId: server.id, ownerViewerId: guest.viewer.id, visibility: "server" });
    const priv = await makePlaylist(db, { serverId: server.id, ownerViewerId: guest.viewer.id });
    // `owner` is the server's admin.
    expect(await deletePlaylist(db, { playlistId: priv.id, viewerId: owner.viewer.id })).toMatchObject({ ok: false, status: 404 });
    expect(await deletePlaylist(db, { playlistId: pub.id, viewerId: owner.viewer.id })).toMatchObject({ ok: true });
    expect(await deletePlaylist(db, { playlistId: priv.id, viewerId: guest.viewer.id })).toMatchObject({ ok: true });
  });

  it("members who aren't owner can't delete", async () => {
    const { owner, server, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "editor");
    expect(await deletePlaylist(db, { playlistId: p.id, viewerId: guest.viewer.id })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("copyPlaylist", () => {
  it("copies only what the COPIER may see, privately, without shares", async () => {
    const { owner, server, library, guest } = await world();
    const src = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, visibility: "server", name: "Src" });
    await addMember(db, src.id, guest.viewer.id, "viewer");
    await seedItem(db, src.id, { titleId: (await makeTitle(db, library.id, { name: "Kid", ratingAges: { US: 0 } })).id }, 1024);
    await seedItem(db, src.id, { titleId: (await makeTitle(db, library.id, { name: "Adult", ratingAges: { US: 17 } })).id }, 2048);
    await seedItem(db, src.id, { titleId: (await makeTitle(db, library.id, { name: "Also kid", ratingAges: { US: 4 } })).id }, 3072);
    const kid = await makeViewer(db, guest.accountId, { role: "limited", maxAge: 12, allowUnrated: false });

    const r = await copyPlaylist(db, { playlistId: src.id, viewerId: kid.id });
    expect(r.ok && r.value.itemsCopied).toBe(2);
    const copy = r.ok ? r.value.playlist : null;
    expect(copy).toMatchObject({ ownerViewerId: kid.id, visibility: "private", name: "Src (copy)" });
    expect(await names(copy!.id, kid.id)).toEqual(["Kid", "Also kid"]);
    expect((await order(copy!.id)).map((i) => i.position)).toEqual([1024, 2048]); // renumbered, no gap
    const detail = await getPlaylistDetail(db, { playlistId: copy!.id, viewerId: owner.viewer.id });
    expect(detail).toMatchObject({ ok: false, status: 404 }); // the copy isn't shared with anyone
  });

  it("is a 404 for someone who can't see the source", async () => {
    const { owner, server, guest } = await world();
    const src = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    expect(await copyPlaylist(db, { playlistId: src.id, viewerId: guest.viewer.id })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("addItem", () => {
  it("lets an editor add, appends one gap after the last, and records who added it", async () => {
    const { owner, server, library, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "editor");
    const a = await makeTitle(db, library.id, { name: "A" });
    const b = await makeTitle(db, library.id, { name: "B" });
    const first = await addItem(db, { playlistId: p.id, viewerId: guest.viewer.id, titleId: a.id });
    const second = await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, titleId: b.id });
    expect(first.ok && first.value.position).toBe(1024);
    expect(second.ok && second.value.position).toBe(2048);
    expect((await order(p.id))[0].addedByViewerId).toBe(guest.viewer.id);
  });

  it("rejects duplicates with 409, but allows a show and one of its episodes", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const { show, episodes: [ep] } = await makeShow(db, library.id, 1);
    expect((await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, titleId: show.id })).ok).toBe(true);
    expect(await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, titleId: show.id })).toMatchObject({ ok: false, status: 409 });
    expect((await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, episodeId: ep.id })).ok).toBe(true);
    expect(await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, episodeId: ep.id })).toMatchObject({ ok: false, status: 409 });
  });

  it("is 403 for a viewer-role member and 404 for a title the actor can't add", async () => {
    const { owner, server, library, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "viewer");
    const t = await makeTitle(db, library.id);
    expect(await addItem(db, { playlistId: p.id, viewerId: guest.viewer.id, titleId: t.id })).toMatchObject({ ok: false, status: 403 });

    const otherServerOwner = await makeAccount(db, "elsewhere");
    const otherServer = await makeServer(db, otherServerOwner.accountId);
    const foreign = await makeTitle(db, (await makeLibrary(db, otherServer.id)).id);
    expect(await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, titleId: foreign.id })).toMatchObject({ ok: false, status: 404 });
    expect(await addItem(db, { playlistId: p.id, viewerId: owner.viewer.id, titleId: "00000000-0000-4000-8000-0000000000ff" })).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a title above the acting profile's age limit (404, same as missing)", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const adult = await makeTitle(db, library.id, { ratingAges: { US: 17 } });
    expect(await addItem(db, { playlistId: p.id, viewerId: kid.id, titleId: adult.id })).toMatchObject({ ok: false, status: 404 });
  });

  it("is a 404 for someone with no access to the playlist", async () => {
    const { owner, server, library, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const t = await makeTitle(db, library.id);
    expect(await addItem(db, { playlistId: p.id, viewerId: guest.viewer.id, titleId: t.id })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("removeItem", () => {
  it("removes a visible item; an item the actor can't see answers 404 and stays", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const fine = await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 0 } })).id }, 1024);
    const blocked = await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 17 } })).id }, 2048);
    expect(await removeItem(db, { playlistId: p.id, viewerId: kid.id, itemId: blocked.id })).toMatchObject({ ok: false, status: 404 });
    expect(await removeItem(db, { playlistId: p.id, viewerId: kid.id, itemId: fine.id })).toMatchObject({ ok: true });
    expect(await order(p.id)).toHaveLength(1);
  });

  it("can't remove an item belonging to another playlist (IDOR)", async () => {
    const { owner, server, library } = await world();
    const mine = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const theirs = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const item = await seedItem(db, theirs.id, { titleId: (await makeTitle(db, library.id)).id });
    expect(await removeItem(db, { playlistId: mine.id, viewerId: owner.viewer.id, itemId: item.id })).toMatchObject({ ok: false, status: 404 });
    expect(await order(theirs.id)).toHaveLength(1);
  });

  it("is 403 for a plain member", async () => {
    const { owner, server, library, guest } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id, "viewer");
    const item = await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id)).id });
    expect(await removeItem(db, { playlistId: p.id, viewerId: guest.viewer.id, itemId: item.id })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("moveItem", () => {
  async function four() {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const items = [];
    for (const [i, name] of ["A", "B", "C", "D"].entries()) {
      const t = await makeTitle(db, library.id, { name, ratingAges: { US: 0 } });
      items.push(await seedItem(db, p.id, { titleId: t.id }, (i + 1) * 1024));
    }
    return { owner, server, library, p, items };
  }

  it("moves an item after another, to the top, and to the end", async () => {
    const { owner, p, items } = await four();
    const [a, b, c, d] = items;
    expect(await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: a.id, afterItemId: c.id })).toMatchObject({ ok: true });
    expect(await names(p.id, owner.viewer.id)).toEqual(["B", "C", "A", "D"]);
    await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: d.id, afterItemId: null });
    expect(await names(p.id, owner.viewer.id)).toEqual(["D", "B", "C", "A"]);
    await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: d.id, afterItemId: a.id });
    expect(await names(p.id, owner.viewer.id)).toEqual(["B", "C", "A", "D"]);
    expect(b.id).toBeTruthy();
  });

  it("renumbers when there is no room between neighbours, keeping the order exact", async () => {
    const { owner, p, items } = await four();
    // Squeeze A, B, C into adjacent integers so a move between them has no gap.
    await db.update(playlistItems).set({ position: 10 }).where(eq(playlistItems.id, items[0].id));
    await db.update(playlistItems).set({ position: 11 }).where(eq(playlistItems.id, items[1].id));
    await db.update(playlistItems).set({ position: 12 }).where(eq(playlistItems.id, items[2].id));
    const r = await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: items[3].id, afterItemId: items[0].id });
    expect(r.ok).toBe(true);
    expect(await names(p.id, owner.viewer.id)).toEqual(["A", "D", "B", "C"]);
    const positions = (await order(p.id)).map((i) => i.position);
    expect(new Set(positions).size).toBe(4); // all distinct after renumbering
  });

  it("rejects moving an item after itself and unknown items", async () => {
    const { owner, p, items } = await four();
    expect(await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: items[0].id, afterItemId: items[0].id })).toMatchObject({ ok: false, status: 400 });
    expect(await moveItem(db, { playlistId: p.id, viewerId: owner.viewer.id, itemId: items[0].id, afterItemId: "00000000-0000-4000-8000-0000000000ee" })).toMatchObject({ ok: false, status: 404 });
  });

  it("a restricted editor reorders what it sees while hidden items keep their slots", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const mk = async (name: string, us: number, pos: number) =>
      seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { name, ratingAges: { US: us } })).id }, pos);
    const a = await mk("A", 0, 1024);
    await mk("X-hidden", 17, 2048);
    const b = await mk("B", 0, 3072);
    await mk("Y-hidden", 17, 4096);
    const c = await mk("C", 0, 5120);

    // The kid moves C to the top: it sees C, A, B, and the hidden ones didn't move relative to each other.
    expect(await moveItem(db, { playlistId: p.id, viewerId: kid.id, itemId: c.id, afterItemId: null })).toMatchObject({ ok: true });
    expect(await names(p.id, kid.id)).toEqual(["C", "A", "B"]);
    const all = (await order(p.id)).map((i) => i.id);
    expect(all.indexOf(a.id)).toBeLessThan(all.indexOf(b.id));
    const adult = await listItems(db, { playlistId: p.id, viewerId: owner.viewer.id });
    expect(adult.ok).toBe(false); // the adult isn't a member of the kid's private playlist
  });

  it("can't move items it can't see or move into another playlist's items", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const ok1 = await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 0 } })).id }, 1024);
    const blocked = await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 17 } })).id }, 2048);
    const other = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const foreignItem = await seedItem(db, other.id, { titleId: (await makeTitle(db, library.id, { ratingAges: { US: 0 } })).id });
    expect(await moveItem(db, { playlistId: p.id, viewerId: kid.id, itemId: blocked.id, afterItemId: null })).toMatchObject({ ok: false, status: 404 });
    expect(await moveItem(db, { playlistId: p.id, viewerId: kid.id, itemId: ok1.id, afterItemId: foreignItem.id })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("listVisibleItems playable flag and listEditablePlaylistsForItem", () => {
  it("marks a show with nothing playable as not playable", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const { show: empty } = await makeShow(db, library.id, 1);
    const { show: playable, episodes: [ep] } = await makeShow(db, library.id, 1);
    await addEpisodeFile(db, ep.id);
    await seedItem(db, p.id, { titleId: empty.id }, 1024);
    await seedItem(db, p.id, { titleId: playable.id }, 2048);
    await seedItem(db, p.id, { titleId: (await makeTitle(db, library.id)).id }, 3072);
    const page = await listItems(db, { playlistId: p.id, viewerId: owner.viewer.id });
    expect(page.ok && page.value.items.map((i) => i.playable)).toEqual([false, true, true]);
  });

  it("lists only playlists the viewer can edit, marking which already hold the item", async () => {
    const { owner, server, library, guest } = await world();
    const t = await makeTitle(db, library.id);
    const mine = await makePlaylist(db, { serverId: server.id, ownerViewerId: guest.viewer.id, name: "mine" });
    const asEditor = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "editor" });
    await addMember(db, asEditor.id, guest.viewer.id, "editor");
    const asViewer = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "viewer-only" });
    await addMember(db, asViewer.id, guest.viewer.id, "viewer");
    await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, visibility: "server", name: "public" });
    const orphan = await makePlaylist(db, { serverId: server.id, ownerViewerId: null, name: "orphan" });
    await addMember(db, orphan.id, guest.viewer.id, "editor");
    const held = await seedItem(db, mine.id, { titleId: t.id });

    const r = await listEditablePlaylistsForItem(db, { serverId: server.id, viewerId: guest.viewer.id, titleId: t.id });
    expect(r.ok && r.value.map((p) => p.name).sort()).toEqual(["editor", "mine"]);
    expect(r.ok && r.value.find((p) => p.name === "mine")?.itemId).toBe(held.id);
    expect(r.ok && r.value.find((p) => p.name === "editor")?.itemId).toBeNull();
  });

  it("is a 404 for a target the viewer can't add (blocked, other server, or no server membership)", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const adult = await makeTitle(db, library.id, { ratingAges: { US: 17 } });
    expect(await listEditablePlaylistsForItem(db, { serverId: server.id, viewerId: kid.id, titleId: adult.id })).toMatchObject({ ok: false, status: 404 });
    const outsider = await makeAccount(db, "outsider");
    expect(await listEditablePlaylistsForItem(db, { serverId: server.id, viewerId: outsider.viewer.id, titleId: adult.id })).toMatchObject({ ok: false, status: 404 });
  });

  it("works for episodes too", async () => {
    const { owner, server, library } = await world();
    const { episodes: [ep] } = await makeShow(db, library.id, 1);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const held = await seedItem(db, p.id, { episodeId: ep.id });
    const r = await listEditablePlaylistsForItem(db, { serverId: server.id, viewerId: owner.viewer.id, episodeId: ep.id });
    expect(r.ok && r.value[0]).toMatchObject({ id: p.id, itemId: held.id });
  });
});
