/** Adding a whole album, or all of an artist's songs, to a playlist. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { musicAlbums, musicArtists, playlistItems, titles, viewers } from "@/lib/db/schema";
import { addSongs, MAX_SONGS_PER_ADD } from "./item-service";
import { listEditablePlaylists } from "./for-item";
import { listVisibleItems } from "./items";
import { addItem, addMember, createTestDb, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
  const album = async (name: string, year: number, songs: string[], over: Partial<typeof titles.$inferInsert> = {}) => {
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: artist.id, name, nameKey: name.toLowerCase(), year }).returning();
    const out = [];
    for (const [i, s] of songs.entries()) out.push(await makeTitle(db, lib.id, { kind: "audiobook", name: s, albumId: al.id, trackNumber: i + 1, sortKey: String(i).padStart(3, "0"), ...over }));
    return { al, songs: out };
  };
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: me.viewer.id, name: "Mine" });
  return { server, me, lib, artist, album, playlist };
}
const names = async (w: Awaited<ReturnType<typeof world>>) =>
  (await listVisibleItems(db, { playlistId: w.playlist.id, lib: { serverId: w.server.id, accountId: w.me.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true } })).items.map((i) => i.name);

describe("addSongs", () => {
  it("adds an album's songs in album order, after what is already there, and skips ones already in the playlist", async () => {
    const w = await world();
    const early = await w.album("Early", 1995, ["E1", "E2", "E3"]);
    const other = await makeTitle(db, w.lib.id, { kind: "audiobook", name: "Already first" });
    await addItem(db, w.playlist.id, { titleId: other.id }, 1024);
    await addItem(db, w.playlist.id, { titleId: early.songs[1].id }, 2048); // E2 is already in
    const r = await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: early.al.id });
    expect(r).toEqual({ ok: true, value: { added: 2, skipped: 1, remaining: 0 } });
    expect(await names(w)).toEqual(["Already first", "E2", "E1", "E3"]); // E2 stays where it was; the new ones follow in order
    const again = await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: early.al.id });
    expect(again).toEqual({ ok: true, value: { added: 0, skipped: 3, remaining: 0 } });
  });
  it("adds all of an artist's songs: albums oldest first, each in order", async () => {
    const w = await world();
    await w.album("Late", 2005, ["L1", "L2"]);
    await w.album("Early", 1995, ["E1", "E2"]);
    const r = await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, artistId: w.artist.id });
    expect(r).toEqual({ ok: true, value: { added: 4, skipped: 0, remaining: 0 } });
    expect(await names(w)).toEqual(["E1", "E2", "L1", "L2"]);
  });
  it("leaves out songs the profile's age limit hides, and refuses when none are visible", async () => {
    const w = await world();
    const mixed = await w.album("Mixed", 2000, ["Kid song"], { ratingAges: { ANY: 0 } });
    await makeTitle(db, w.lib.id, { kind: "audiobook", name: "Adult song", albumId: mixed.al.id, trackNumber: 2, sortKey: "002", ratingAges: { ANY: 17 } });
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.me.viewer.id));
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: mixed.al.id })).toEqual({ ok: true, value: { added: 1, skipped: 0, remaining: 0 } });
    const adultOnly = await w.album("Adults", 2001, ["Nope"], { ratingAges: { ANY: 17 } });
    const refused = await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: adultOnly.al.id });
    expect(refused).toMatchObject({ ok: false, status: 404 });
  });
  it("is refused for a viewer-only member, a stranger, a missing album and another server's album", async () => {
    const w = await world();
    const al = await w.album("A", 2000, ["S1"]);
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    await addMember(db, w.playlist.id, friend.viewer.id, "viewer");
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: friend.viewer.id, albumId: al.al.id })).toMatchObject({ ok: false, status: 403 });
    const stranger = await makeAccount(db, "stranger");
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: stranger.viewer.id, albumId: al.al.id })).toMatchObject({ ok: false, status: 404 });
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: "00000000-0000-4000-8000-0000000000aa" })).toMatchObject({ ok: false, status: 404 });
    const other = await world();
    const theirs = await other.album("Theirs", 2000, ["T1"]);
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, albumId: theirs.al.id })).toMatchObject({ ok: false, status: 404 });
    expect(await addSongs(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id })).toMatchObject({ ok: false, status: 404 }); // neither album nor artist
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, w.playlist.id))).toHaveLength(0);
  });
  it("lets an editor add, and stops at the per-add limit for a huge artist", async () => {
    const w = await world();
    const editor = await makeAccount(db, "editor");
    await joinServer(db, w.server.id, editor.accountId);
    await addMember(db, w.playlist.id, editor.viewer.id, "editor");
    const [al] = await db.insert(musicAlbums).values({ libraryId: w.lib.id, artistId: w.artist.id, name: "Huge", nameKey: "huge", year: 2000 }).returning();
    await db.insert(titles).values(Array.from({ length: MAX_SONGS_PER_ADD + 5 }, (_, i) => ({ libraryId: w.lib.id, kind: "audiobook" as const, name: `Song ${i}`, boxFolderId: `huge-${i}`, albumId: al.id, trackNumber: i + 1, sortKey: String(i).padStart(4, "0") })));
    const r = await addSongs(db, { playlistId: w.playlist.id, viewerId: editor.viewer.id, artistId: w.artist.id });
    expect(r).toEqual({ ok: true, value: { added: MAX_SONGS_PER_ADD, skipped: 0, remaining: 5 } });
    // adding again carries on where it stopped (the cap counts only songs that would go in), so a big artist can be added in rounds
    const rest = await addSongs(db, { playlistId: w.playlist.id, viewerId: editor.viewer.id, artistId: w.artist.id });
    expect(rest).toEqual({ ok: true, value: { added: 5, skipped: MAX_SONGS_PER_ADD, remaining: 0 } });
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, w.playlist.id))).toHaveLength(MAX_SONGS_PER_ADD + 5);
  });
});

describe("listEditablePlaylists", () => {
  it("lists the playlists a profile owns or edits, and not ones it only views", async () => {
    const w = await world();
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const edits = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Friend edit" });
    const views = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Friend view", visibility: "server" });
    await addMember(db, edits.id, w.me.viewer.id, "editor");
    await addMember(db, views.id, w.me.viewer.id, "viewer");
    const r = await listEditablePlaylists(db, { serverId: w.server.id, viewerId: w.me.viewer.id });
    expect(r.ok && r.value.map((p) => p.name).sort()).toEqual(["Friend edit", "Mine"]);
    const stranger = await makeAccount(db, "stranger");
    expect(await listEditablePlaylists(db, { serverId: w.server.id, viewerId: stranger.viewer.id })).toMatchObject({ ok: false, status: 404 });
  });
});
