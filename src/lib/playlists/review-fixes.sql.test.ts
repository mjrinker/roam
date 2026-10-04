/** Regression tests for the review's smaller findings: transfer rules and a move whose anchor is gone. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { playlistItems, playlistMembers, viewers } from "@/lib/db/schema";
import { transferOwnership } from "./member-service";
import { moveItem } from "./item-service";
import { addMember, addItem, createTestDb, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, makeViewer, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const hasShare = async (playlistId: string, viewerId: string) =>
  (await db.select().from(playlistMembers).where(and(eq(playlistMembers.playlistId, playlistId), eq(playlistMembers.viewerId, viewerId)))).length > 0;

describe("transferOwnership", () => {
  it("drops hidden profiles that would end up with access across accounts", async () => {
    const owner = await makeAccount(db, "owner");
    const server = await makeServer(db, owner.accountId);
    const other = await makeAccount(db, "other");
    await joinServer(db, server.id, other.accountId);
    const hiddenSibling = await makeViewer(db, owner.accountId, { visibleOnServer: false });
    const shownSibling = await makeViewer(db, owner.accountId);
    const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, playlist.id, other.viewer.id, "editor", owner.viewer.id);
    await addMember(db, playlist.id, hiddenSibling.id, "viewer", owner.viewer.id);
    await addMember(db, playlist.id, shownSibling.id, "viewer", owner.viewer.id);

    const r = await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: other.viewer.id });
    expect(r.ok).toBe(true);
    expect(await hasShare(playlist.id, hiddenSibling.id)).toBe(false);
    expect(await hasShare(playlist.id, shownSibling.id)).toBe(true);
  });

  it("won't let a limited owner hand the playlist to another account", async () => {
    const owner = await makeAccount(db, "limitedowner");
    await db.update(viewers).set({ role: "limited" }).where(eq(viewers.id, owner.viewer.id));
    const server = await makeServer(db, owner.accountId);
    const other = await makeAccount(db, "other2");
    await joinServer(db, server.id, other.accountId);
    const sibling = await makeViewer(db, owner.accountId);
    const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, playlist.id, other.viewer.id, "viewer", owner.viewer.id);
    await addMember(db, playlist.id, sibling.id, "viewer", owner.viewer.id);

    const toOther = await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: other.viewer.id });
    expect(toOther).toMatchObject({ ok: false, status: 404 });
    const toSibling = await transferOwnership(db, { playlistId: playlist.id, viewerId: owner.viewer.id, targetViewerId: sibling.id });
    expect(toSibling.ok).toBe(true);
  });
});

describe("moveItem", () => {
  it("reports not found, instead of moving to the top, when the item to go after isn't in the playlist", async () => {
    const owner = await makeAccount(db, "mover");
    const server = await makeServer(db, owner.accountId);
    const library = await makeLibrary(db, server.id);
    const a = await makeTitle(db, library.id);
    const b = await makeTitle(db, library.id);
    const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const first = await addItem(db, playlist.id, { titleId: a.id }, 1024);
    const second = await addItem(db, playlist.id, { titleId: b.id }, 2048);

    const ghost = "00000000-0000-4000-8000-000000000000";
    const r = await moveItem(db, { playlistId: playlist.id, viewerId: owner.viewer.id, itemId: second.id, afterItemId: ghost });
    expect(r).toMatchObject({ ok: false, status: 404 });
    // Nothing moved: the second item is still after the first.
    const rows = await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlist.id));
    expect(rows.find((x) => x.id === second.id)?.position).toBe(2048);
    expect(rows.find((x) => x.id === first.id)?.position).toBe(1024);
  });
});
