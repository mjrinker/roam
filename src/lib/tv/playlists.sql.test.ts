/** Playlists on a TV: what is listed, what opens, and what stays hidden. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { viewers } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import { addItem, addMember, createTestDb, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { TvScope } from "./data";
import { parsePlaylistCursor, playlistItemHref, playlistItemLabel, TV_PLAYLIST_PAGE, tvPlaylist, tvPlaylists } from "./playlists";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const friend = await makeAccount(db, "friend");
  await joinServer(db, server.id, friend.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const scope = (who = member, viewer = adult): TvScope => ({ actor: { serverId: server.id, accountId: who.accountId, isAdmin: false }, viewer, viewerId: who.viewer.id });
  return { admin, server, member, friend, movies, scope };
}

describe("tvPlaylists", () => {
  it("lists a profile's own playlists, ones shared with it and public ones, but not someone else's private ones", async () => {
    const w = await world();
    const mine = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Mine" });
    const shared = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.friend.viewer.id, name: "Shared" });
    await addMember(db, shared.id, w.member.viewer.id);
    await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.friend.viewer.id, name: "Public", visibility: "server" });
    await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.friend.viewer.id, name: "Private" });
    const names = (await tvPlaylists(db, w.scope())).map((p) => p.name).sort();
    expect(names).toEqual(["Mine", "Public", "Shared"]);
    expect(mine.id).toBeTruthy();
  });
  it("counts only the items this profile may see", async () => {
    const w = await world();
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Mixed" });
    await addItem(db, list.id, { titleId: (await makeTitle(db, w.movies.id, { kind: "movie", name: "Kids", ratingAges: { ANY: 0 } })).id }, 1024);
    await addItem(db, list.id, { titleId: (await makeTitle(db, w.movies.id, { kind: "movie", name: "Grown-up", ratingAges: { ANY: 17 } })).id }, 2048);
    expect((await tvPlaylists(db, w.scope()))[0].itemCount).toBe(2);
    // the playlist code reads the profile's limit from the stored profile, so set it there
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.member.viewer.id));
    expect((await tvPlaylists(db, w.scope(w.member, kid)))[0].itemCount).toBe(1);
  });
  it("shows nothing from other servers", async () => {
    const w = await world();
    const other = await world();
    await makePlaylist(db, { serverId: other.server.id, ownerViewerId: other.member.viewer.id, name: "Theirs", visibility: "server" });
    expect(await tvPlaylists(db, w.scope())).toEqual([]);
  });
});

describe("tvPlaylist", () => {
  it("shows the items in order, pages them, and labels episodes, movies and books", async () => {
    const w = await world();
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Watch" });
    const film = await makeTitle(db, w.movies.id, { kind: "movie", name: "Film", year: 1999 });
    const { show, episodes: eps } = await makeShow(db, (await makeLibrary(db, w.server.id, "shows", "everyone")).id, 2, { name: "Show" });
    const book = await makeTitle(db, (await makeLibrary(db, w.server.id, "audiobooks", "everyone")).id, { kind: "audiobook", name: "Book" });
    await addItem(db, list.id, { titleId: film.id }, 1024);
    await addItem(db, list.id, { episodeId: eps[1].id }, 2048);
    await addItem(db, list.id, { titleId: book.id }, 3072);
    await addItem(db, list.id, { titleId: show.id }, 4096);
    const r = (await tvPlaylist(db, w.scope(), list.id, null))!;
    expect(r.playlist.name).toBe("Watch");
    // things that play carry the playlist and their own item, so what follows in the playlist plays next; a show opens its page
    const q = (i: number) => `?playlist=${list.id}&item=${r.items[i].id}`;
    expect(r.items.map((i) => playlistItemHref(i, list.id))).toEqual([`/watch/title/${film.id}${q(0)}`, `/watch/episode/${eps[1].id}${q(1)}`, `/listen/${book.id}${q(2)}`, `/show/${show.id}`]);
    expect(playlistItemLabel(r.items[0])).toEqual({ name: "Film", meta: "1999" });
    expect(playlistItemLabel(r.items[1])).toEqual({ name: "Show", meta: "S1 · E2 · Ep 2" });
    // a picture or an eBook in a playlist has nothing to open on a TV, so it gets no link (the card is left out)
    expect(playlistItemHref({ id: "i", episodeId: null, titleId: "x", titleKind: "photo" }, "p")).toBeNull();
    expect(playlistItemHref({ id: "i", episodeId: null, titleId: "x", titleKind: "ebook" }, "p")).toBeNull();
    for (let i = 0; i < TV_PLAYLIST_PAGE + 2; i++) await addItem(db, list.id, { titleId: (await makeTitle(db, w.movies.id, { kind: "movie", name: `M${i}` })).id }, 10_000 + i);
    const first = (await tvPlaylist(db, w.scope(), list.id, null))!;
    expect(first.items).toHaveLength(TV_PLAYLIST_PAGE);
    const second = (await tvPlaylist(db, w.scope(), list.id, first.nextCursor))!;
    expect(second.items.length).toBe(4 + TV_PLAYLIST_PAGE + 2 - TV_PLAYLIST_PAGE);
    expect(second.nextCursor).toBeNull();
  });
  it("is null for someone else's private playlist, another server's, and a missing one; hides over-age items", async () => {
    const w = await world();
    const priv = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.friend.viewer.id, name: "Private" });
    expect(await tvPlaylist(db, w.scope(), priv.id, null)).toBeNull();
    const other = await world();
    const theirs = await makePlaylist(db, { serverId: other.server.id, ownerViewerId: other.member.viewer.id, name: "Theirs", visibility: "server" });
    expect(await tvPlaylist(db, w.scope(), theirs.id, null)).toBeNull();
    // even someone who belongs to BOTH servers must not read the other server's playlist through this one
    await joinServer(db, other.server.id, w.member.accountId);
    expect(await tvPlaylist(db, w.scope(), theirs.id, null)).toBeNull();
    expect(await tvPlaylist(db, other.scope(w.member), theirs.id, null)).not.toBeNull();
    expect(await tvPlaylist(db, w.scope(), "00000000-0000-4000-8000-0000000000aa", null)).toBeNull();
    const own = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Own" });
    await addItem(db, own.id, { titleId: (await makeTitle(db, w.movies.id, { kind: "movie", name: "Adult", ratingAges: { ANY: 17 } })).id });
    expect((await tvPlaylist(db, w.scope(w.member, kid), own.id, null))!.items).toEqual([]);
    expect((await tvPlaylist(db, w.scope(), own.id, null))!.items).toHaveLength(1);
  });
  it("reads a cursor only when well formed", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(parsePlaylistCursor(null)).toBeNull();
    expect(parsePlaylistCursor(`2048~${id}`)).toEqual({ position: 2048, id });
    for (const bad of ["x", `~${id}`, `-1~${id}`, `1.5~${id}`, `9999999999999999999~${id}`, "5~nope", `abc~${id}`]) expect(parsePlaylistCursor(bad), bad).toBe("bad");
  });
});
