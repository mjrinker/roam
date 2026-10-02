/**
 * Real-SQL behavior on an in-memory Postgres (pglite) with every repo
 * migration applied: constraints, cascades, SET NULL, the lifecycle helpers
 * and the filtered item reads. Each test builds its own server, so tests
 * share one database without interfering.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { playlistItems, playlistMembers, playlists, serverMembers, titles, viewers } from "@/lib/db/schema";
import { countVisibleItems, listVisibleItems } from "./items";
import { deleteOwnedUnsharedPlaylists, purgeOrphansForAccount, revokeCrossAccountShares } from "./lifecycle";
import { purgeOrphanPlaylists } from "./purge";
import {
  addItem,
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

/** A server with an owner account and a library; the usual starting point. */
async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id);
  return { owner, server, library };
}

const exists = async (id: string) => (await db.select().from(playlists).where(eq(playlists.id, id))).length === 1;

describe("playlist_items constraints", () => {
  it("rejects a row with neither or both targets", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const t = await makeTitle(db, library.id);
    const { episodes: [ep] } = await makeShow(db, library.id, 1);
    await expect(db.insert(playlistItems).values({ playlistId: p.id, position: 1 })).rejects.toThrow();
    await expect(
      db.insert(playlistItems).values({ playlistId: p.id, position: 1, titleId: t.id, episodeId: ep.id })
    ).rejects.toThrow();
  });

  it("rejects duplicate titles and duplicate episodes, but allows a show and its own episode together", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const { show, episodes: [ep] } = await makeShow(db, library.id, 1);
    await addItem(db, p.id, { titleId: show.id }, 1024);
    await expect(addItem(db, p.id, { titleId: show.id }, 2048)).rejects.toThrow();
    await addItem(db, p.id, { episodeId: ep.id }, 2048); // show + its episode may coexist
    await expect(addItem(db, p.id, { episodeId: ep.id }, 3072)).rejects.toThrow();
  });

  it("allows the same title in two different playlists", async () => {
    const { owner, server, library } = await world();
    const a = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const b = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const t = await makeTitle(db, library.id);
    await addItem(db, a.id, { titleId: t.id });
    await addItem(db, b.id, { titleId: t.id });
  });

  it("removes items when their title or episode is deleted, and when the playlist is deleted", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const t = await makeTitle(db, library.id);
    const { show, episodes: [ep] } = await makeShow(db, library.id, 1);
    await addItem(db, p.id, { titleId: t.id }, 1);
    await addItem(db, p.id, { episodeId: ep.id }, 2);
    await db.delete(titles).where(eq(titles.id, t.id));
    await db.delete(titles).where(eq(titles.id, show.id)); // cascades show -> season -> episode -> item
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, p.id))).toHaveLength(0);
  });
});

describe("owner and member deletion semantics", () => {
  it("sets the owner to NULL when the owner's viewer is deleted, and drops that viewer's member rows", async () => {
    const { owner, server } = await world();
    const sibling = await makeViewer(db, owner.accountId);
    const guest = await makeAccount(db, "guest");
    await joinServer(db, server.id, guest.accountId);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: sibling.id });
    await addMember(db, p.id, guest.viewer.id, "editor");
    await db.delete(viewers).where(eq(viewers.id, sibling.id));
    const [row] = await db.select().from(playlists).where(eq(playlists.id, p.id));
    expect(row.ownerViewerId).toBeNull();
    await db.delete(viewers).where(eq(viewers.id, guest.viewer.id));
    expect(await db.select().from(playlistMembers).where(eq(playlistMembers.playlistId, p.id))).toHaveLength(0);
  });

  it("enforces one member row per viewer per playlist", async () => {
    const { owner, server } = await world();
    const guest = await makeAccount(db, "guest");
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, guest.viewer.id);
    await expect(addMember(db, p.id, guest.viewer.id, "editor")).rejects.toThrow();
  });
});

describe("purgeOrphanPlaylists", () => {
  it("deletes unshared private playlists with no owner, and keeps everything else", async () => {
    const { owner, server } = await world();
    const guest = await makeAccount(db, "guest");
    await joinServer(db, server.id, guest.accountId);

    const ownerless = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    const ownerlessShared = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await addMember(db, ownerlessShared.id, guest.viewer.id);
    const ownerlessPublic = await makePlaylist(db, { serverId: server.id, ownerViewerId: null, visibility: "server" });
    const healthy = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });

    expect(await purgeOrphanPlaylists(db, server.id)).toBe(1);
    expect(await exists(ownerless.id)).toBe(false);
    expect(await exists(ownerlessShared.id)).toBe(true);
    expect(await exists(ownerlessPublic.id)).toBe(true);
    expect(await exists(healthy.id)).toBe(true);
    expect(await purgeOrphanPlaylists(db, server.id)).toBe(0); // idempotent
  });

  it("treats an owner whose account left the server as orphaned, but only on that server", async () => {
    const { owner, server } = await world();
    const leaver = await makeAccount(db, "leaver");
    await joinServer(db, server.id, leaver.accountId);
    const other = await makeServer(db, owner.accountId);
    await joinServer(db, other.id, leaver.accountId);

    const here = await makePlaylist(db, { serverId: server.id, ownerViewerId: leaver.viewer.id });
    const there = await makePlaylist(db, { serverId: other.id, ownerViewerId: leaver.viewer.id });
    await db
      .delete(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.profileId, leaver.accountId)));
    await purgeOrphanPlaylists(db, server.id);
    expect(await exists(here.id)).toBe(false);
    expect(await exists(there.id)).toBe(true); // other server untouched (the leaver is still a member there)
    await purgeOrphanPlaylists(db, other.id);
    expect(await exists(there.id)).toBe(true); // ... and not orphaned there either
  });

  it("never touches another server's playlists", async () => {
    const a = await world();
    const b = await world();
    const orphanB = await makePlaylist(db, { serverId: b.server.id, ownerViewerId: null });
    await purgeOrphanPlaylists(db, a.server.id);
    expect(await exists(orphanB.id)).toBe(true);
  });
});

describe("viewer-delete lifecycle", () => {
  it("deletes the deleted viewer's unshared private playlists, keeps shared/public ones (now ownerless)", async () => {
    const { owner, server } = await world();
    const leaving = await makeViewer(db, owner.accountId);
    const guest = await makeAccount(db, "guest");
    await joinServer(db, server.id, guest.accountId);

    const unshared = await makePlaylist(db, { serverId: server.id, ownerViewerId: leaving.id });
    const shared = await makePlaylist(db, { serverId: server.id, ownerViewerId: leaving.id });
    await addMember(db, shared.id, guest.viewer.id);
    const pub = await makePlaylist(db, { serverId: server.id, ownerViewerId: leaving.id, visibility: "server" });

    await db.transaction(async (tx) => {
      expect(await deleteOwnedUnsharedPlaylists(tx, leaving.id)).toBe(1);
      await tx.delete(viewers).where(eq(viewers.id, leaving.id));
      await purgeOrphansForAccount(tx, owner.accountId);
    });

    expect(await exists(unshared.id)).toBe(false);
    const [s] = await db.select().from(playlists).where(eq(playlists.id, shared.id));
    expect(s.ownerViewerId).toBeNull();
    const [pb] = await db.select().from(playlists).where(eq(playlists.id, pub.id));
    expect(pb.ownerViewerId).toBeNull();
  });

  it("collects an ownerless private playlist whose LAST member is the deleted viewer", async () => {
    const { owner, server } = await world();
    const doomed = await makeViewer(db, owner.accountId);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await addMember(db, p.id, doomed.id);
    await db.transaction(async (tx) => {
      await deleteOwnedUnsharedPlaylists(tx, doomed.id);
      await tx.delete(viewers).where(eq(viewers.id, doomed.id));
      await purgeOrphansForAccount(tx, owner.accountId);
    });
    expect(await exists(p.id)).toBe(false);
  });

  it("a playlist shared after the lock was taken survives (fresh-snapshot re-check)", async () => {
    const { owner, server } = await world();
    const leaving = await makeViewer(db, owner.accountId);
    const guest = await makeAccount(db, "guest");
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: leaving.id });
    await addMember(db, p.id, guest.viewer.id); // shared before the delete statement runs
    expect(await deleteOwnedUnsharedPlaylists(db, leaving.id)).toBe(0);
    expect(await exists(p.id)).toBe(true);
  });
});

describe("revokeCrossAccountShares", () => {
  it("removes a hidden viewer's access to other accounts' playlists only", async () => {
    const { owner, server } = await world();
    const hider = await makeAccount(db, "hider");
    const hiderSibling = await makeViewer(db, hider.accountId);
    await joinServer(db, server.id, hider.accountId);

    const foreign = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, foreign.id, hider.viewer.id);
    const ownerless = await makePlaylist(db, { serverId: server.id, ownerViewerId: null });
    await addMember(db, ownerless.id, hider.viewer.id);
    const sameAccount = await makePlaylist(db, { serverId: server.id, ownerViewerId: hiderSibling.id });
    await addMember(db, sameAccount.id, hider.viewer.id);
    const hidersOwn = await makePlaylist(db, { serverId: server.id, ownerViewerId: hider.viewer.id });
    await addMember(db, hidersOwn.id, owner.viewer.id); // a share the hider granted: unchanged

    expect(await revokeCrossAccountShares(db, hider.viewer.id, hider.accountId)).toBe(2);
    const left = (id: string) => db.select().from(playlistMembers).where(eq(playlistMembers.playlistId, id));
    expect(await left(foreign.id)).toHaveLength(0);
    expect(await left(ownerless.id)).toHaveLength(0);
    expect(await left(sameAccount.id)).toHaveLength(1);
    expect(await left(hidersOwn.id)).toHaveLength(1);
  });
});

describe("listVisibleItems / countVisibleItems", () => {
  const adult = { locale: "en-US", maxAge: null, allowUnrated: false };
  const kid = { locale: "en-US", maxAge: 12, allowUnrated: false };

  it("returns items in position order with a stable cursor and no hidden-item leakage", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const g = await makeTitle(db, library.id, { name: "G", ratingAges: { US: 0 } });
    const r = await makeTitle(db, library.id, { name: "R", ratingAges: { US: 17 } });
    const pg = await makeTitle(db, library.id, { name: "PG", ratingAges: { US: 8 } });
    const unrated = await makeTitle(db, library.id, { name: "Unrated" });
    await addItem(db, p.id, { titleId: g.id }, 1000);
    await addItem(db, p.id, { titleId: r.id }, 2000);
    await addItem(db, p.id, { titleId: pg.id }, 3000);
    await addItem(db, p.id, { titleId: unrated.id }, 4000);

    const all = await listVisibleItems(db, { playlistId: p.id, serverId: server.id, viewer: adult });
    expect(all.items.map((i) => i.name)).toEqual(["G", "R", "PG", "Unrated"]);
    expect(all.nextCursor).toBeNull();

    // The kid never sees R or the unrated title, and page lengths don't reveal the gap.
    const first = await listVisibleItems(db, { playlistId: p.id, serverId: server.id, viewer: kid, limit: 1 });
    expect(first.items.map((i) => i.name)).toEqual(["G"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listVisibleItems(db, {
      playlistId: p.id,
      serverId: server.id,
      viewer: kid,
      limit: 1,
      after: first.nextCursor,
    });
    expect(second.items.map((i) => i.name)).toEqual(["PG"]);
    expect(second.nextCursor).toBeNull();

    const counts = await countVisibleItems(db, { playlistIds: [p.id], serverId: server.id, viewer: kid });
    expect(counts.get(p.id)).toBe(2);
    const adultCounts = await countVisibleItems(db, { playlistIds: [p.id], serverId: server.id, viewer: adult });
    expect(adultCounts.get(p.id)).toBe(4);
  });

  it("rates an episode by its show and returns show/season/episode context", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const { show, episodes: [ep] } = await makeShow(db, library.id, 1, { name: "Grown-up Show", ratingAges: { US: 17 } });
    await addItem(db, p.id, { episodeId: ep.id });
    const forKid = await listVisibleItems(db, { playlistId: p.id, serverId: server.id, viewer: kid });
    expect(forKid.items).toHaveLength(0);
    const forAdult = await listVisibleItems(db, { playlistId: p.id, serverId: server.id, viewer: adult });
    expect(forAdult.items[0]).toMatchObject({ showName: "Grown-up Show", showId: show.id, seasonNumber: 1, episodeNumber: 1 });
  });

  it("never returns items whose library is on a different server", async () => {
    const mine = await world();
    const theirs = await world();
    const p = await makePlaylist(db, { serverId: mine.server.id, ownerViewerId: mine.owner.viewer.id });
    const foreignTitle = await makeTitle(db, theirs.library.id, { name: "Elsewhere" });
    await addItem(db, p.id, { titleId: foreignTitle.id });
    const page = await listVisibleItems(db, { playlistId: p.id, serverId: mine.server.id, viewer: adult });
    expect(page.items).toHaveLength(0);
    const counts = await countVisibleItems(db, { playlistIds: [p.id], serverId: mine.server.id, viewer: adult });
    expect(counts.get(p.id)).toBe(0);
  });

  it("counts zero for empty playlists and ignores unknown ids", async () => {
    const { owner, server } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const counts = await countVisibleItems(db, { playlistIds: [p.id], serverId: server.id, viewer: adult });
    expect(counts.get(p.id)).toBe(0);
    expect((await countVisibleItems(db, { playlistIds: [], serverId: server.id, viewer: adult })).size).toBe(0);
  });
});
