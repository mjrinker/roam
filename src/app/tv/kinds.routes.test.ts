/** The TV pages end to end at the route level: who gets in, what they see, and what is hidden from them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  profile: null as unknown,
  jar: new Map<string, string>(),
  signedOut: 0,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (arg: string | { name: string }) => void h.jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
}));
vi.mock("@/lib/auth/viewer", async () => {
  const { eq } = await import("drizzle-orm");
  const { viewers } = await import("@/lib/db/schema");
  return {
    getCurrentViewer: async () => h.resolution,
    listViewers: async (accountId: string) => h.testDb.db.select().from(viewers).where(eq(viewers.accountId, accountId)),
  };
});
vi.mock("@/lib/auth/guards", async () => {
  const { and, eq } = await import("drizzle-orm");
  const { serverMembers } = await import("@/lib/db/schema");
  return {
    getCurrentProfile: async () => h.profile,
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
    getCurrentServerMember: async (serverId: string) => {
      const r = h.resolution as { account: { id: string }; viewer: unknown } | null;
      if (!r?.viewer) return null;
      const m = (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, r.account.id), eq(serverMembers.serverId, serverId))).limit(1))[0];
      return m ? { profile: r.account, viewer: r.viewer, role: m.role } : null;
    },
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { episodes as episodesTable, musicAlbums, musicArtists, photoFavorites, profiles, seasons as seasonsTable, viewers, watchState } from "@/lib/db/schema";
import { addMember, addEpisodeFile, addItem, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as home } from "./s/[serverId]/route";
import { GET as library } from "./s/[serverId]/library/[id]/route";
import { GET as book } from "./s/[serverId]/book/[id]/route";
import { GET as listen } from "./s/[serverId]/listen/[id]/route";
import { GET as artist } from "./s/[serverId]/artist/[id]/route";
import { GET as album } from "./s/[serverId]/album/[id]/route";
import { GET as photo } from "./s/[serverId]/photo/[id]/route";
import { GET as watch } from "./s/[serverId]/watch/[kind]/[id]/route";
import { GET as title } from "./s/[serverId]/title/[id]/route";
import { GET as artistPlay } from "./s/[serverId]/artist/[id]/play/route";
import { GET as search } from "./s/[serverId]/search/route";
import { GET as screensaver } from "./s/[serverId]/screensaver/route";
import { GET as playlists } from "./s/[serverId]/playlists/route";
import { GET as playlist } from "./s/[serverId]/playlist/[id]/route";
import { tvPlaylist } from "@/lib/tv/playlists";
import { GET as markGet, POST as markPost } from "./s/[serverId]/mark/route";
import { GET as show } from "./s/[serverId]/show/[id]/route";
import { GET as addGet, POST as addPost } from "./s/[serverId]/add/route";
import { GET as playlistPlay } from "./s/[serverId]/playlist/[id]/play/route";

let db: TestDb;
beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = h.testDb.db;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  h.resolution = null;
  h.profile = null;
  h.jar.clear();
});

const req = (path: string) => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const text = async (r: Response) => r.text();

async function signIn(who: Awaited<ReturnType<typeof makeAccount>>) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, who.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  h.profile = account;
}

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const lib = (kind: Parameters<typeof makeLibrary>[2]) => makeLibrary(db, server.id, kind, access);
  await signIn(member);
  return { server, member, lib };
}
const sid = (w: { server: { id: string } }) => ({ serverId: w.server.id });

describe("video and audio folders", () => {
  it("shows folders then files, plays a clip from a video library, and sends Back up a level", async () => {
    const w = await world();
    const lib = await w.lib("video");
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Beach <day>", folderPath: "Trips/2024" });
    await makeTitle(db, lib.id, { kind: "movie", name: "Loose", folderPath: "" });
    const root = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(root).toContain(`library/${lib.id}?path=Trips`);
    expect(root).toContain("Loose");
    const deep = await text(await library(req(`/x?path=${encodeURIComponent("Trips/2024")}`), ctx({ ...sid(w), id: lib.id })));
    expect(deep).toContain("Beach &lt;day&gt;"); // names are escaped
    expect(deep).not.toContain("Beach <day>");
    expect(deep).toContain(`href="/tv/s/${w.server.id}/title/${clip.id}"`);
    expect(deep).toContain(`data-back href="/tv/s/${w.server.id}/library/${lib.id}?path=Trips"`); // one level up
    const watching = await text(await watch(req("/x"), ctx({ ...sid(w), kind: "title", id: clip.id })));
    expect(watching).toContain(`"back":"/tv/s/${w.server.id}/library/${lib.id}?path=Trips%2F2024"`);
  });
  it("opens an audio file on the listening page", async () => {
    const w = await world();
    const lib = await w.lib("audio");
    const file = await makeTitle(db, lib.id, { kind: "audiobook", name: "A Talk", authors: ["Speaker"], folderPath: "" });
    const page = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(page).toContain(`href="/tv/s/${w.server.id}/listen/${file.id}"`);
    expect(page).toContain("Speaker");
  });
  it("answers 404 for an unsafe path, a bad cursor, a missing folder and a hidden library", async () => {
    const w = await world();
    const lib = await w.lib("video");
    await makeTitle(db, lib.id, { kind: "movie", name: "X", folderPath: "A" });
    const statuses = [];
    const dashes = `?after=x~${"-".repeat(36)}`;
    for (const q of ["?path=..%2Fx", "?path=A%2F%2FB", "?after=garbage", "?path=Missing", dashes, "?after=k%00x~0f8fad5b-d9cb-469f-a165-70867728950e"]) statuses.push((await library(req(`/x${q}`), ctx({ ...sid(w), id: lib.id }))).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    const hidden = await world("restricted");
    expect((await library(req("/x"), ctx({ ...sid(hidden), id: (await hidden.lib("video")).id }))).status).toBe(404);
    // an artist grid takes the same cursor, and refuses a malformed one the same way
    const music = await w.lib("music");
    expect((await library(req(`/x${dashes}`), ctx({ ...sid(w), id: music.id }))).status).toBe(404);
  });
});

describe("a video in a nested folder", () => {
  it("sends Back from its page to that folder", async () => {
    const w = await world();
    const lib = await w.lib("video");
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Deep", folderPath: "A/B" });
    const page = await text(await title(req("/x"), ctx({ ...sid(w), id: clip.id })));
    expect(page).toContain(`data-back href="/tv/s/${w.server.id}/library/${lib.id}?path=A%2FB"`);
    const movie = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Plain" });
    expect(await text(await title(req("/x"), ctx({ ...sid(w), id: movie.id })))).toContain(`data-back href="/tv/s/${w.server.id}/library/${movie.libraryId}"`);
  });
});

describe("backdrops and the basic-only switch", () => {
  it("puts a movie's wide picture in a data attribute (so a basic page never downloads it), and the switch marks every page", async () => {
    const w = await world();
    const movie = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film", backdropUrl: "https://img.example/wide.jpg" });
    const page = await text(await title(req("/x"), ctx({ ...sid(w), id: movie.id })));
    expect(page).toContain('<img data-src="https://img.example/wide.jpg"');
    expect(page).not.toContain(' src="https://img.example/wide.jpg"');
    expect(page).toContain("<html lang=\"en\">");
    vi.stubEnv("TV_BASIC_ONLY", "1");
    try {
      expect(await text(await title(req("/x"), ctx({ ...sid(w), id: movie.id })))).toContain('<html lang="en" data-basic="1">');
    } finally {
      vi.stubEnv("TV_BASIC_ONLY", "");
    }
    const bad = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Bad", backdropUrl: "javascript:alert(1)" });
    expect(await text(await title(req("/x"), ctx({ ...sid(w), id: bad.id })))).not.toContain("javascript:");
  });
});

describe("audiobooks", () => {
  it("lists books, shows one with Resume, and plays it", async () => {
    const w = await world();
    const lib = await w.lib("audiobooks");
    const b = await makeTitle(db, lib.id, { kind: "audiobook", name: "The Hobbit", authors: ["J. R. R. Tolkien"], narrators: ["Rob Inglis"], overview: "There and back again.", posterUrl: "https://img.example/hobbit.jpg" });
    const grid = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(grid).toContain(`href="/tv/s/${w.server.id}/book/${b.id}"`);
    expect(grid).toContain("J. R. R. Tolkien");
    const detail = await text(await book(req("/x"), ctx({ ...sid(w), id: b.id })));
    expect(detail).toContain("Read by Rob Inglis");
    expect(detail).toContain("There and back again.");
    expect(detail).toContain(`href="/tv/s/${w.server.id}/listen/${b.id}"`);
    const listening = await text(await listen(req("/x"), ctx({ ...sid(w), id: b.id })));
    expect(listening).toContain('id="listen-config"');
    expect(listening).toContain('"remembers":true');
    expect(listening).toContain(`"back":"/tv/s/${w.server.id}/book/${b.id}"`);
  });
  it("hides a book from another server, a hidden library and a movie id", async () => {
    const w = await world();
    const movie = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    const other = await world();
    const theirs = await makeTitle(db, (await other.lib("audiobooks")).id, { kind: "audiobook", name: "Theirs" });
    await signIn(w.member);
    const r = [await book(req("/x"), ctx({ ...sid(w), id: movie.id })), await book(req("/x"), ctx({ ...sid(w), id: theirs.id })), await listen(req("/x"), ctx({ ...sid(w), id: theirs.id })), await listen(req("/x"), ctx({ ...sid(w), id: movie.id }))];
    expect(r.map((x) => x.status)).toEqual([404, 404, 404, 404]);
  });
});

describe("music", () => {
  async function setup() {
    const w = await world();
    const lib = await w.lib("music");
    const [art] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "The Band", nameKey: "the band", sortKey: "band" }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: art.id, name: "First Record", nameKey: "first record", year: 1999 }).returning();
    const songs = [];
    for (const [i, name] of ["Intro", "Song <2>"].entries()) songs.push(await makeTitle(db, lib.id, { kind: "audiobook", name, albumId: al.id, trackNumber: i + 1, sortKey: String(i), authors: ["The Band"] }));
    return { w, lib, art, al, songs };
  }
  it("goes artists, albums, songs, then plays with the next song queued and Back to the album", async () => {
    const { w, lib, art, al, songs } = await setup();
    const artists = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(artists).toContain(`href="/tv/s/${w.server.id}/artist/${art.id}"`);
    expect(artists).toContain("1 album");
    const albums = await text(await artist(req("/x"), ctx({ ...sid(w), id: art.id })));
    expect(albums).toContain(`href="/tv/s/${w.server.id}/album/${al.id}"`);
    expect(albums).toContain("1999 · 2 songs");
    const tracks = await text(await album(req("/x"), ctx({ ...sid(w), id: al.id })));
    expect(tracks).toContain("Song &lt;2&gt;");
    expect(tracks).toContain("Play album");
    expect(tracks).toContain(`href="/tv/s/${w.server.id}/listen/${songs[0].id}"`);
    const first = await text(await listen(req("/x"), ctx({ ...sid(w), id: songs[0].id })));
    expect(first).toContain('"remembers":false'); // songs never remember a place
    expect(first).toContain(`"next":"/tv/s/${w.server.id}/listen/${songs[1].id}"`);
    expect(first).toContain(`"back":"/tv/s/${w.server.id}/album/${al.id}"`);
    const cfg = JSON.parse(/id="listen-config">(.*?)<\/script>/.exec(first)![1]);
    expect(cfg.queue).toEqual({ items: [{ id: songs[0].id, title: "Intro", by: "The Band" }, { id: songs[1].id, title: "Song <2>", by: "The Band" }], index: 0, cover: null });
    expect(first).not.toContain("Song <2>"); // a song's name inside the page data is escaped
    expect(await text(await listen(req("/x"), ctx({ ...sid(w), id: songs[1].id })))).toContain('"next":null');
  });
  it("404s an artist or album from another server or a hidden library", async () => {
    const { w, art, al } = await setup();
    const other = await setup();
    await signIn(w.member);
    const r = [await artist(req("/x"), ctx({ ...sid(w), id: other.art.id })), await album(req("/x"), ctx({ ...sid(w), id: other.al.id }))];
    expect(r.map((x) => x.status)).toEqual([404, 404]);
    const hiddenWorld = await world("restricted");
    const lib = await hiddenWorld.lib("music");
    const [a2] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Hidden", nameKey: "hidden", sortKey: "hidden" }).returning();
    const [al2] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: a2.id, name: "Hidden LP", nameKey: "hidden lp" }).returning();
    await makeTitle(db, lib.id, { kind: "audiobook", name: "S", albumId: al2.id, trackNumber: 1 });
    expect([(await artist(req("/x"), ctx({ ...sid(hiddenWorld), id: a2.id }))).status, (await album(req("/x"), ctx({ ...sid(hiddenWorld), id: al2.id }))).status, (await library(req("/x"), ctx({ ...sid(hiddenWorld), id: lib.id }))).status]).toEqual([404, 404, 404]);
    expect(art.id).toBeTruthy();
    expect(al.id).toBeTruthy();
  });
});

describe("music: shuffle and play all", () => {
  it("offers Shuffle on an album and Play all and Shuffle on an artist, each starting a queue that carries on from song to song", async () => {
    const w = await world();
    const lib = await w.lib("music");
    const [art] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: art.id, name: "LP", nameKey: "lp", year: 2000 }).returning();
    const songs = [];
    for (const [i, name] of ["One", "Two", "Three", "Four"].entries()) songs.push(await makeTitle(db, lib.id, { kind: "audiobook", name, albumId: al.id, trackNumber: i + 1, sortKey: String(i) }));
    const albumPage = await text(await album(req("/x"), ctx({ ...sid(w), id: al.id })));
    const shuffleHref = /href="([^"]*\?shuffle=\d+)"[^>]*>Shuffle</.exec(albumPage)![1];
    expect(shuffleHref).toMatch(new RegExp(`^/tv/s/${w.server.id}/listen/[0-9a-f-]{36}\\?shuffle=\\d+$`));
    const artistPage = await text(await artist(req("/x"), ctx({ ...sid(w), id: art.id })));
    expect(artistPage).toContain(`href="/tv/s/${w.server.id}/artist/${art.id}/play"`);
    expect(artistPage).toContain(`href="/tv/s/${w.server.id}/artist/${art.id}/play?shuffle=1"`);

    // a shuffled song's page lists the queue in the same order the seed gives, and its next link keeps the seed
    const [, id, seed] = /listen\/([0-9a-f-]{36})\?shuffle=(\d+)/.exec(shuffleHref)!;
    const page = await text(await listen(req(`/x?shuffle=${seed}`), ctx({ ...sid(w), id })));
    const cfg = JSON.parse(/id="listen-config">(.*?)<\/script>/.exec(page)![1]);
    expect(cfg.queue.items.map((i: { title: string }) => i.title).sort()).toEqual(["Four", "One", "Three", "Two"]);
    expect(cfg.queue.index).toBe(0);
    expect(cfg.next).toBe(`/tv/s/${w.server.id}/listen/${cfg.queue.items[1].id}?shuffle=${seed}`);

    // the artist's play-all redirects to the first song with the artist in the address, and Back goes to the artist
    const start = await artistPlay(req("/x"), ctx({ ...sid(w), id: art.id }));
    expect(start.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/listen/${songs[0].id}?artist=${art.id}`);
    const playing = JSON.parse(/id="listen-config">(.*?)<\/script>/.exec(await text(await listen(req(`/x?artist=${art.id}`), ctx({ ...sid(w), id: songs[0].id }))))![1]);
    expect(playing.back).toBe(`/tv/s/${w.server.id}/artist/${art.id}`);
    expect(playing.next).toBe(`/tv/s/${w.server.id}/listen/${songs[1].id}?artist=${art.id}`);
    const mixed = await artistPlay(req("/x?shuffle=1"), ctx({ ...sid(w), id: art.id }));
    expect(mixed.headers.get("location")).toMatch(new RegExp(`/listen/[0-9a-f-]{36}\\?artist=${art.id}&shuffle=\\d+$`));
  });
  it("ignores a bad artist or seed in the address, and 404s play-all for hidden or missing artists", async () => {
    const w = await world();
    const lib = await w.lib("music");
    const [art] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: art.id, name: "LP", nameKey: "lp" }).returning();
    const song = await makeTitle(db, lib.id, { kind: "audiobook", name: "One", albumId: al.id, trackNumber: 1 });
    const plain = JSON.parse(/id="listen-config">(.*?)<\/script>/.exec(await text(await listen(req("/x?artist=not-a-uuid&shuffle=-5"), ctx({ ...sid(w), id: song.id }))))![1]);
    expect(plain.back).toBe(`/tv/s/${w.server.id}/album/${al.id}`);
    expect((await artistPlay(req("/x"), ctx({ ...sid(w), id: "00000000-0000-4000-8000-0000000000aa" }))).status).toBe(404);
    const hidden = await world("restricted");
    const hl = await hidden.lib("music");
    const [ha] = await db.insert(musicArtists).values({ libraryId: hl.id, name: "H", nameKey: "h", sortKey: "h" }).returning();
    const [hal] = await db.insert(musicAlbums).values({ libraryId: hl.id, artistId: ha.id, name: "HL", nameKey: "hl" }).returning();
    await makeTitle(db, hl.id, { kind: "audiobook", name: "S", albumId: hal.id, trackNumber: 1 });
    expect((await artistPlay(req("/x"), ctx({ ...sid(hidden), id: ha.id }))).status).toBe(404);
  });
});

describe("photos", () => {
  const day = (d: number) => new Date(Date.UTC(2024, 4, d, 12));
  it("shows pictures newest first, opens one with its neighbours, and Back reopens the grid at that picture", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const a = await makeTitle(db, lib.id, { kind: "photo", name: "A", takenAt: day(1) });
    const b = await makeTitle(db, lib.id, { kind: "photo", name: "B", takenAt: day(2) });
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Clip", takenAt: day(3) });
    const grid = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(grid.indexOf("Clip")).toBeLessThan(grid.indexOf(">B<"));
    expect(grid).toContain(`href="/tv/s/${w.server.id}/watch/title/${clip.id}"`); // a clip plays, a picture is viewed
    expect(grid).toContain(`href="/tv/s/${w.server.id}/photo/${b.id}"`);
    const page = await text(await photo(req("/x"), ctx({ ...sid(w), id: b.id })));
    expect(page).toContain(`src="/api/photos/${b.id}/preview"`);
    expect(page).toContain(`"prev":"/tv/s/${w.server.id}/watch/title/${clip.id}"`);
    expect(page).toContain(`"next":"/tv/s/${w.server.id}/photo/${a.id}"`);
    const t = Math.floor(day(2).getTime() / 1000) + 1;
    const cursor = `${t}~ffffffff-ffff-4fff-bfff-ffffffffffff`;
    expect(page).toContain(`"back":"/tv/s/${w.server.id}/library/${lib.id}?after=${cursor}"`);
    // that Back address reopens the grid starting at B
    const reopened = await text(await library(req(`/x?after=${encodeURIComponent(cursor)}`), ctx({ ...sid(w), id: lib.id })));
    expect(reopened).toContain(`/photo/${b.id}"`);
    expect(reopened).not.toContain(`/watch/title/${clip.id}`);
  });
  it("sends a clip opened as a picture to the video player, and 404s other servers, bad cursors and hidden libraries", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Clip", takenAt: day(3) });
    const moved = await photo(req("/x"), ctx({ ...sid(w), id: clip.id }));
    expect([moved.status, moved.headers.get("location")]).toEqual([302, `https://roam.example/tv/s/${w.server.id}/watch/title/${clip.id}`]);
    expect((await library(req("/x?after=junk"), ctx({ ...sid(w), id: lib.id }))).status).toBe(404);
    // Back from the clip's watch page opens the grid at the clip (not the same clip again)
    const watching = await text(await watch(req("/x"), ctx({ ...sid(w), kind: "title", id: clip.id })));
    const back = /"back":"([^"]+)"/.exec(watching)![1];
    expect(back).toContain(`/library/${lib.id}?after=`);
    const grid = await library(req(back), ctx({ ...sid(w), id: lib.id }));
    expect(grid.status).toBe(200);
    expect(await text(grid)).toContain("Clip");
    expect((await library(req("/x?after=5~notanid"), ctx({ ...sid(w), id: lib.id }))).status).toBe(404);
    const other = await world();
    const theirs = await makeTitle(db, (await other.lib("photos")).id, { kind: "photo", name: "Theirs", takenAt: day(1) });
    await signIn(w.member);
    expect((await photo(req("/x"), ctx({ ...sid(w), id: theirs.id }))).status).toBe(404);
  });
});

describe("search", () => {
  it("shows a keyboard whose keys add a letter, the typed text, and results that link to their pages", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Moon <Rise>" });
    const empty = await text(await search(req("/x"), ctx(sid(w))));
    expect(empty).toContain("Type to search");
    expect(empty).toContain(`href="/tv/s/${w.server.id}/search?q=a&amp;k=a"`); // the A key adds an "a"
    expect(empty).toContain(`class="key" data-f data-autofocus href="/tv/s/${w.server.id}/search?q=a&amp;k=a"`); // starts on the first key
    const typed = await text(await search(req("/x?q=mo&k=o"), ctx(sid(w))));
    expect(typed).toContain(`href="/tv/s/${w.server.id}/search?q=mon&amp;k=n"`);
    expect(typed).toContain(`href="/tv/s/${w.server.id}/search?q=m&amp;k=del"`); // Delete drops the last letter
    expect(typed).toContain(`href="/tv/s/${w.server.id}/search?q=&amp;k=clear"`);
    expect(typed).toContain(`class="key" data-f data-autofocus href="/tv/s/${w.server.id}/search?q=moo&amp;k=o"`); // focus returns to the key just pressed
    expect(typed).toContain("Moon &lt;Rise&gt;");
    expect(typed).not.toContain("Moon <Rise>");
    expect(typed).toContain(`href="/tv/s/${w.server.id}/title/${film.id}"`);
    expect(await text(await search(req("/x?q=zzzz"), ctx(sid(w))))).toContain("Nothing found.");
  });
  it("copes with hostile input, a full box and a missing server", async () => {
    const w = await world();
    const hostile = await text(await search(req(`/x?q=${encodeURIComponent("<script>alert(1)</script>")}&k=${encodeURIComponent('"><x>')}`), ctx(sid(w))));
    expect(hostile).not.toContain("<script>alert");
    expect(hostile).toContain("&lt;script&gt;");
    const long = await text(await search(req(`/x?q=${"a".repeat(300)}&k=a`), ctx(sid(w))));
    expect(long).toContain("a".repeat(40));
    expect(long).not.toContain("a".repeat(41));
    expect((await search(req("/x"), ctx({ serverId: "not-a-uuid" }))).status).toBe(404);
    const other = await world();
    await signIn(w.member);
    expect((await search(req("/x"), ctx(sid(other)))).status).toBe(404); // a server the signed-in person is not in
  });
  it("never finds a hidden library's titles", async () => {
    const hidden = await world("restricted");
    await makeTitle(db, (await hidden.lib("movies")).id, { kind: "movie", name: "Secret Film" });
    expect(await text(await search(req("/x?q=secret"), ctx(sid(hidden))))).toContain("Nothing found.");
  });
});

describe("playlists", () => {
  it("lists playlists, opens one, links each item to its page and pages with a cursor", async () => {
    const w = await world();
    const movies = await w.lib("movies");
    const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film <1>" });
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Friday <night>" });
    await addItem(db, list.id, { titleId: film.id }, 1024);
    for (let i = 0; i < 25; i++) await addItem(db, list.id, { titleId: (await makeTitle(db, movies.id, { kind: "movie", name: `Extra ${i}` })).id }, 2000 + i);
    const home1 = await text(await home(req("/x"), ctx(sid(w))));
    expect(home1).toContain(`href="/tv/s/${w.server.id}/playlists"`);
    const lists = await text(await playlists(req("/x"), ctx(sid(w))));
    expect(lists).toContain("Friday &lt;night&gt;");
    expect(lists).toContain("26 items");
    expect(lists).toContain(`href="/tv/s/${w.server.id}/playlist/${list.id}"`);
    const page = await text(await playlist(req("/x"), ctx({ ...sid(w), id: list.id })));
    expect(page).toContain("Film &lt;1&gt;");
    expect(page).toContain(`href="/tv/s/${w.server.id}/watch/title/${film.id}?playlist=${list.id}&amp;item=`);
    expect(page).toContain(`href="/tv/s/${w.server.id}/playlist/${list.id}/play"`);
    const more = /href="([^"]*playlist\/[^"]*after=[^"]+)"/.exec(page)![1].replace(/&amp;/g, "&");
    expect(await text(await playlist(req(more), ctx({ ...sid(w), id: list.id })))).toContain("Extra 24");
    expect((await playlist(req(`/x?after=bogus`), ctx({ ...sid(w), id: list.id }))).status).toBe(404);
  });
  it("hides the button with no playlists, and 404s a private playlist of someone else's and another server's", async () => {
    const w = await world();
    expect(await text(await home(req("/x"), ctx(sid(w))))).not.toContain("/playlists");
    expect(await text(await playlists(req("/x"), ctx(sid(w))))).toContain("No playlists yet");
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const priv = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Private" });
    expect((await playlist(req("/x"), ctx({ ...sid(w), id: priv.id }))).status).toBe(404);
    const other = await world();
    const theirs = await makePlaylist(db, { serverId: other.server.id, ownerViewerId: other.member.viewer.id, name: "T", visibility: "server" });
    await signIn(w.member);
    expect((await playlist(req("/x"), ctx({ ...sid(w), id: theirs.id }))).status).toBe(404);
  });
});

describe("playing a playlist through", () => {
  const cfgOf = (page: string) => JSON.parse(/id="play-config">(.*?)<\/script>/.exec(page)![1]);
  async function setup() {
    const w = await world();
    const movies = await w.lib("movies");
    const m1 = await makeTitle(db, movies.id, { kind: "movie", name: "First" });
    const m2 = await makeTitle(db, movies.id, { kind: "movie", name: "Second" });
    const book = await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "Book" });
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Queue" });
    const i1 = await addItem(db, list.id, { titleId: m1.id }, 1024);
    const i2 = await addItem(db, list.id, { titleId: m2.id }, 2048);
    const i3 = await addItem(db, list.id, { titleId: book.id }, 3072);
    return { w, list, m1, m2, book, i1, i2, i3 };
  }
  it("Play all starts at the first item, and each item points to the next, ending at the playlist", async () => {
    const { w, list, m1, m2, book, i1, i2, i3 } = await setup();
    const start = await playlistPlay(req("/x"), ctx({ ...sid(w), id: list.id }));
    expect([start.status, start.headers.get("location")]).toEqual([302, `https://roam.example/tv/s/${w.server.id}/watch/title/${m1.id}?playlist=${list.id}&item=${i1.id}`]);
    const first = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${i1.id}`), ctx({ ...sid(w), kind: "title", id: m1.id }))));
    expect(first).toMatchObject({ back: `/tv/s/${w.server.id}/playlist/${list.id}`, next: `/tv/s/${w.server.id}/watch/title/${m2.id}?playlist=${list.id}&item=${i2.id}` });
    const second = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${i2.id}`), ctx({ ...sid(w), kind: "title", id: m2.id }))));
    expect(second.next).toBe(`/tv/s/${w.server.id}/listen/${book.id}?playlist=${list.id}&item=${i3.id}`); // a book plays on the audio screen
    const listening = JSON.parse(/id="listen-config">(.*?)<\/script>/.exec(await text(await listen(req(`/x?playlist=${list.id}&item=${i3.id}`), ctx({ ...sid(w), id: book.id }))))![1]);
    expect(listening).toMatchObject({ next: null, back: `/tv/s/${w.server.id}/playlist/${list.id}`, queue: null });
    // the Up-next lookup follows the queue too
    const lookup = await (await watch(req(`/x?json=1&playlist=${list.id}&item=${i1.id}`), ctx({ ...sid(w), kind: "title", id: m1.id }))).json();
    expect(lookup.next).toContain(`/watch/title/${m2.id}?playlist=`);
  });
  it("follows a queue only on the server its playlist belongs to, and hides Play all when nothing in the playlist can play", async () => {
    const { w, list, m1, i1 } = await setup();
    // someone in two servers cannot walk a queue of one through the other's addresses
    const other = await world();
    const theirs = await makePlaylist(db, { serverId: other.server.id, ownerViewerId: other.member.viewer.id, name: "Other server" });
    const film = await makeTitle(db, (await other.lib("movies")).id, { kind: "movie", name: "Theirs" });
    await addItem(db, theirs.id, { titleId: film.id });
    await joinServer(db, w.server.id, other.member.accountId);
    await signIn(other.member);
    expect((await playlistPlay(req("/x"), ctx({ ...sid(w), id: theirs.id }))).status).toBe(404);
    await signIn(w.member);
    // a playlist with only a picture in it has nothing to play
    const photoLib = await w.lib("photos");
    const pic = await makeTitle(db, photoLib.id, { kind: "photo", name: "Pic", takenAt: new Date() });
    const photoList = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Pictures" });
    await addItem(db, photoList.id, { titleId: pic.id });
    expect(await text(await playlist(req("/x"), ctx({ ...sid(w), id: photoList.id })))).not.toContain("/play\"");
    expect(await text(await playlist(req("/x"), ctx({ ...sid(w), id: list.id })))).toContain("/play\"");
    expect(m1.id).toBeTruthy();
    expect(i1.id).toBeTruthy();
  });
  it("ignores a queue that isn't genuine: another item's id, a playlist that is not yours, junk", async () => {
    const { w, list, m1, m2, i1 } = await setup();
    // the page plays m1 but claims to be item 1's neighbour: m2 is not item i1
    const wrong = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${i1.id}`), ctx({ ...sid(w), kind: "title", id: m2.id }))));
    expect(wrong).toMatchObject({ next: null, back: expect.stringContaining("/title/") });
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const priv = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Theirs" });
    const pi = await addItem(db, priv.id, { titleId: m1.id });
    const peek = cfgOf(await text(await watch(req(`/x?playlist=${priv.id}&item=${pi.id}`), ctx({ ...sid(w), kind: "title", id: m1.id }))));
    expect(peek.back).not.toContain("/playlist/");
    const junk = cfgOf(await text(await watch(req("/x?playlist=nope&item=nope"), ctx({ ...sid(w), kind: "title", id: m1.id }))));
    expect(junk.back).not.toContain("/playlist/");
    expect((await playlistPlay(req("/x"), ctx({ ...sid(w), id: priv.id }))).status).toBe(404);
  });
  it("steps through a show entry's episodes, then on to the next item; skips what the profile can't see", async () => {
    const w = await world();
    const shows = await w.lib("shows");
    const { show, episodes: eps } = await makeShow(db, shows.id, 2, { name: "Show", ratingAges: { ANY: 0 } });
    for (const e of eps) await addEpisodeFile(db, e.id);
    const movie = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "After", ratingAges: { ANY: 0 } });
    const hidden = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Adult", ratingAges: { ANY: 17 } });
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Q" });
    const si = await addItem(db, list.id, { titleId: show.id }, 1024);
    await addItem(db, list.id, { titleId: hidden.id }, 1500);
    const mi = await addItem(db, list.id, { titleId: movie.id }, 2048);
    const start = await playlistPlay(req("/x"), ctx({ ...sid(w), id: list.id }));
    expect(start.headers.get("location")).toContain(`/watch/episode/${eps[0].id}?playlist=${list.id}&item=${si.id}`);
    const e1 = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${si.id}`), ctx({ ...sid(w), kind: "episode", id: eps[0].id }))));
    expect(e1.next).toBe(`/tv/s/${w.server.id}/watch/episode/${eps[1].id}?playlist=${list.id}&item=${si.id}`);
    const e2 = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${si.id}`), ctx({ ...sid(w), kind: "episode", id: eps[1].id }))));
    // an adult profile goes on to the next item, whatever it is...
    expect(e2.next).toContain(`/watch/title/${hidden.id}?playlist=${list.id}&item=`);
    // ...a child's profile skips the one it may not see and goes to the one after
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    const kidE2 = cfgOf(await text(await watch(req(`/x?playlist=${list.id}&item=${si.id}`), ctx({ ...sid(w), kind: "episode", id: eps[1].id }))));
    expect(kidE2.next).toBe(`/tv/s/${w.server.id}/watch/title/${movie.id}?playlist=${list.id}&item=${mi.id}`);
  });
});

describe("marking watched, listened to and read from the TV", () => {
  const post = (w: { server: { id: string } }, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    markPost(new Request(`https://roam.example/tv/s/${w.server.id}/mark`, { method: "POST", body: new URLSearchParams(fields), headers }), ctx(sid(w)));
  const doneRows = async (viewerId: string) => (await db.select().from(watchState).where(eq(watchState.viewerId, viewerId))).filter((r) => r.finished);

  it("marks a movie watched and unwatched, with the button's words following the state, and returns to the page", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    const page = async () => text(await title(req("/x"), ctx({ ...sid(w), id: film.id })));
    expect(await page()).toContain("Mark as watched");
    const back = `/tv/s/${w.server.id}/title/${film.id}`;
    const res = await post(w, { kind: "title", id: film.id, done: "1", back });
    expect([res.status, res.headers.get("location")]).toEqual([303, `https://roam.example${back}`]);
    expect((await doneRows(w.member.viewer.id)).map((r) => r.ownerId)).toEqual([film.id]);
    expect(await page()).toContain("Mark as unwatched");
    await post(w, { kind: "title", id: film.id, done: "0", back });
    expect(await doneRows(w.member.viewer.id)).toEqual([]);
    expect(await page()).toContain("Mark as watched");
  });
  it("says listened to for a book, and marks a show and a season with their own buttons", async () => {
    const w = await world();
    const b = await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "Book" });
    expect(await text(await book(req("/x"), ctx({ ...sid(w), id: b.id })))).toContain("Mark as listened to");
    await post(w, { kind: "title", id: b.id, done: "1" });
    expect(await text(await book(req("/x"), ctx({ ...sid(w), id: b.id })))).toContain("Mark as not listened to");

    const { show: s, season, episodes: eps } = await makeShow(db, (await w.lib("shows")).id, 2, { name: "Show" });
    const [s2] = await db.insert(seasonsTable).values({ titleId: s.id, number: 2, boxFolderId: `x-${s.id}` }).returning();
    const [s2e1] = await db.insert(episodesTable).values({ seasonId: s2.id, number: 1, name: "S2E1" }).returning();
    for (const e of [...eps, s2e1]) await addEpisodeFile(db, e.id); // only episodes that can play count towards "the whole show"
    const showPage = async () => text(await show(req("/x"), ctx({ ...sid(w), id: s.id })));
    const first = await showPage();
    expect(first).toContain("Mark show as watched");
    expect(first).toContain("Mark season 1 as watched");
    await post(w, { kind: "season", id: season.id, done: "1" });
    const afterSeason = await showPage();
    expect(afterSeason).toContain("Mark season 1 as unwatched");
    expect(afterSeason).toContain("Mark show as watched"); // season two is still to watch
    await post(w, { kind: "show", id: s.id, done: "1" });
    expect(await showPage()).toContain("Mark show as unwatched");
    expect((await doneRows(w.member.viewer.id)).filter((r) => r.ownerKind === "episode")).toHaveLength(3);
    expect(eps).toHaveLength(2);
  });
  it("offers nothing on a clip beside pictures, and refuses to mark what can't be marked, hidden items, another site's post and a wrong 'back'", async () => {
    const w = await world();
    const clip = await makeTitle(db, (await w.lib("photos")).id, { kind: "movie", name: "Clip", takenAt: new Date() });
    expect(await text(await title(req("/x"), ctx({ ...sid(w), id: clip.id })))).not.toContain("Mark as");
    expect((await post(w, { kind: "title", id: clip.id, done: "1" })).status).toBe(404);
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    expect((await post(w, { kind: "title", id: film.id, done: "1" }, { origin: "https://evil.example" })).status).toBe(404);
    const bads: Record<string, string>[] = [{ kind: "movie", id: film.id, done: "1" }, { kind: "title", id: "nope", done: "1" }, { kind: "title", id: film.id, done: "2" }, { kind: "title", id: film.id }];
    for (const bad of bads) expect((await post(w, bad)).status, JSON.stringify(bad)).toBe(404);
    const evil = await post(w, { kind: "title", id: film.id, done: "1", back: "https://evil.example/" });
    expect(evil.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}`);
    const hidden = await world("restricted");
    const secret = await makeTitle(db, (await hidden.lib("movies")).id, { kind: "movie", name: "Secret" });
    const refused = await post(hidden, { kind: "title", id: secret.id, done: "1" });
    expect(refused.status).toBe(404);
    expect(await doneRows(hidden.member.viewer.id)).toEqual([]);
    const opened = await markGet(req("/x"), ctx(sid(w)));
    expect([opened.status, opened.headers.get("location")]).toEqual([302, `https://roam.example/tv/s/${w.server.id}`]); // a plain visit marks nothing
  });
});

describe("music: mark an album and add albums and artists to a playlist from the TV", () => {
  const formPost = (w: { server: { id: string } }, path: string, fields: Record<string, string>) =>
    markPost(new Request(`https://roam.example/tv/s/${w.server.id}/${path}`, { method: "POST", body: new URLSearchParams(fields) }), ctx(sid(w)));
  async function setup() {
    const w = await world();
    const lib = await w.lib("music");
    const [art] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band <&>", nameKey: "band", sortKey: "band" }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: art.id, name: "LP", nameKey: "lp", year: 2000 }).returning();
    const songs = [];
    for (const [i, name] of ["One", "Two", "Three"].entries()) songs.push(await makeTitle(db, lib.id, { kind: "audiobook", name, albumId: al.id, trackNumber: i + 1, sortKey: String(i) }));
    const list = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Mix" });
    return { w, art, al, songs, list };
  }
  const itemsIn = async (w: { server: { id: string }; member: { accountId: string; viewer: { id: string } } }, id: string) =>
    (await tvPlaylist(db, { actor: { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.member.viewer.id }, id, null))?.items.map((i) => i.name) ?? [];

  it("marks the whole album listened to and back, with the album page's button following", async () => {
    const { w, al } = await setup();
    const page = async () => text(await album(req("/x"), ctx({ ...sid(w), id: al.id })));
    expect(await page()).toContain("Mark as listened to");
    const back = `/tv/s/${w.server.id}/album/${al.id}`;
    const res = await formPost(w, "mark", { kind: "album", id: al.id, done: "1", back });
    expect([res.status, res.headers.get("location")]).toEqual([303, `https://roam.example${back}`]);
    expect(await page()).toContain("Mark as not listened to");
    await formPost(w, "mark", { kind: "album", id: al.id, done: "0", back });
    expect(await page()).toContain("Mark as listened to");
  });
  it("adds an album, and then all of an artist's songs, to a playlist, saying how many went in", async () => {
    const { w, art, al, list } = await setup();
    const chooser = await text(await addGet(req(`/x?album=${al.id}`), ctx(sid(w))));
    expect(chooser).toContain("LP · 3 songs");
    expect(chooser).toContain("Mix");
    expect(chooser).toContain(`name="album" value="${al.id}"`);
    const added = await text(await addPost(new Request(`https://roam.example/tv/s/${w.server.id}/add`, { method: "POST", body: new URLSearchParams({ playlist: list.id, album: al.id }) }), ctx(sid(w))));
    expect(added).toContain("Added 3 songs to your playlist.");
    expect(await itemsIn(w, list.id)).toEqual(["One", "Two", "Three"]);
    const again = await text(await addPost(new Request(`https://roam.example/tv/s/${w.server.id}/add`, { method: "POST", body: new URLSearchParams({ playlist: list.id, artist: art.id }) }), ctx(sid(w))));
    expect(again).toContain("already in this playlist");
    expect(await text(await addGet(req(`/x?artist=${art.id}`), ctx(sid(w))))).toContain("Band &lt;&amp;&gt; · 3 songs");
    const artistPage = await text(await artist(req("/x"), ctx({ ...sid(w), id: art.id })));
    expect(artistPage).toContain(`/add?artist=${art.id}`);
    expect(await text(await album(req("/x"), ctx({ ...sid(w), id: al.id })))).toContain(`/add?album=${al.id}`);
  });
  it("won't add a hidden album or one from another server, or into a playlist that can't be changed", async () => {
    const { w, al } = await setup();
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const viewOnly = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "View only", visibility: "server" });
    const post = (fields: Record<string, string>) => addPost(new Request(`https://roam.example/tv/s/${w.server.id}/add`, { method: "POST", body: new URLSearchParams(fields) }), ctx(sid(w)));
    expect((await post({ playlist: viewOnly.id, album: al.id })).status).toBe(404);
    const other = await world();
    const lib = await other.lib("music");
    const [oa] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Other", nameKey: "o", sortKey: "o" }).returning();
    const [oal] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: oa.id, name: "Theirs", nameKey: "t" }).returning();
    await makeTitle(db, lib.id, { kind: "audiobook", name: "T1", albumId: oal.id, trackNumber: 1 });
    await signIn(w.member);
    expect((await addGet(req(`/x?album=${oal.id}`), ctx(sid(w)))).status).toBe(404);
    expect((await addGet(req("/x?album=00000000-0000-4000-8000-0000000000aa"), ctx(sid(w)))).status).toBe(404);
  });
});

describe("adding to a playlist from the TV", () => {
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`https://roam.example${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
  async function setup() {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film <x>" });
    const mine = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id, name: "Mine" });
    return { w, film, mine };
  }
  // how many items this profile sees in a playlist (read the way the TV reads it, never straight from the tables)
  const inList = async (w: { server: { id: string }; member: { accountId: string; viewer: { id: string } } }, playlistId: string) =>
    (await tvPlaylist(db, { actor: { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.member.viewer.id }, playlistId, null))?.items.length ?? 0;

  it("offers the title pages an Add to playlist button, and lists only playlists this profile can add to", async () => {
    const { w, film, mine } = await setup();
    const page = await text(await title(req("/x"), ctx({ ...sid(w), id: film.id })));
    expect(page).toContain(`href="/tv/s/${w.server.id}/add?title=${film.id}&amp;back=`);
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const theirs = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Friend's view-only", visibility: "server" });
    const shared = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "Friend's shared edit" });
    await addMember(db, shared.id, w.member.viewer.id, "editor");
    await addMember(db, theirs.id, w.member.viewer.id, "viewer");
    const chooser = await text(await addGet(req(`/x?title=${film.id}&back=${encodeURIComponent(`/tv/s/${w.server.id}/title/${film.id}`)}`), ctx(sid(w))));
    expect(chooser).toContain("Film &lt;x&gt;");
    expect(chooser).toContain("Mine");
    expect(chooser).toContain("shared edit"); // an editor can add
    expect(chooser).not.toContain("view-only"); // a viewer cannot
    expect(chooser).toContain(`value="${mine.id}"`);
  });
  it("adds on POST, says when it is already there, and refuses a playlist that can't be changed", async () => {
    const { w, film, mine } = await setup();
    const post = (fields: Record<string, string>) => addPost(form(`/tv/s/${w.server.id}/add`, fields), ctx(sid(w)));
    const ok = await post({ playlist: mine.id, title: film.id, back: `/tv/s/${w.server.id}/title/${film.id}` });
    expect(ok.status).toBe(200);
    expect(await text(ok)).toContain("Added to your playlist.");
    expect(await inList(w, mine.id)).toBe(1);
    const again = await post({ playlist: mine.id, title: film.id });
    expect(await text(again)).toContain("already in this playlist");
    expect(await inList(w, mine.id)).toBe(1);
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    const viewOnly = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: friend.viewer.id, name: "V", visibility: "server" });
    const refused = await post({ playlist: viewOnly.id, title: film.id });
    expect(refused.status).toBe(404);
    expect(await inList(w, viewOnly.id)).toBe(0);
  });
  it("treats an Origin of null, a missing Origin and a body that is not a form without crashing", async () => {
    const { w, film, mine } = await setup();
    const call = (init: RequestInit) => addPost(new Request(`https://roam.example/tv/s/${w.server.id}/add`, { method: "POST", ...init }), ctx(sid(w)));
    expect((await call({ body: new URLSearchParams({ playlist: mine.id, title: film.id }), headers: { origin: "null" } })).status).toBe(404);
    expect(await inList(w, mine.id)).toBe(0);
    expect((await call({ body: "{not a form", headers: { "content-type": "application/json" } })).status).toBe(404);
    // a request with no Origin at all (some TV browsers send none) is allowed: the sign-in cookie only travels with same-site requests
    expect((await call({ body: new URLSearchParams({ playlist: mine.id, title: film.id }) })).status).toBe(200);
    expect(await inList(w, mine.id)).toBe(1);
  });
  it("won't add something hidden, from another server, or on a POST from another site, and cleans the back address", async () => {
    const { w, film, mine } = await setup();
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => addPost(form(`/tv/s/${w.server.id}/add`, fields, headers), ctx(sid(w)));
    const adult = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Adult", ratingAges: { ANY: 17 } });
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    expect((await post({ playlist: mine.id, title: adult.id })).status).toBe(404);
    expect((await addGet(req(`/x?title=${adult.id}`), ctx(sid(w)))).status).toBe(404);
    await db.update(viewers).set({ maxAge: null, allowUnrated: true }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    const other = await world();
    const theirs = await makeTitle(db, (await other.lib("movies")).id, { kind: "movie", name: "Theirs" });
    await signIn(w.member);
    expect((await post({ playlist: mine.id, title: theirs.id })).status).toBe(404);
    expect((await post({ playlist: mine.id, title: film.id }, { origin: "https://evil.example" })).status).toBe(404);
    expect(await inList(w, mine.id)).toBe(0);
    for (const bad of ["https://evil.example/x", "//evil.example", `/tv/s/${w.server.id}//evil.example`, "javascript:alert(1)", `/tv/s/${w.server.id}/x\\y`]) {
      const res = await post({ playlist: mine.id, title: film.id, back: bad });
      expect(await text(res), bad).not.toContain("evil.example");
    }
    const chooser = await text(await addGet(req(`/x?title=${film.id}&back=https://evil.example/`), ctx(sid(w))));
    expect(chooser).not.toContain("evil.example");
    expect((await addGet(req("/x"), ctx(sid(w)))).status).toBe(404); // nothing to add
    expect((await addPost(form("/x", { playlist: mine.id, title: film.id }), ctx({ serverId: "nope" }))).status).toBe(404);
  });
});

describe("photo albums and favourites", () => {
  const day = (d: number) => new Date(Date.UTC(2024, 4, d, 12));
  it("offers Albums and Favourites on the first screen only, and opens each", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const a = await makeTitle(db, lib.id, { kind: "photo", name: "Paris 1", takenAt: day(1), folderPath: "Trips/Paris", sortKey: "p1" });
    const b = await makeTitle(db, lib.id, { kind: "photo", name: "Paris 2", takenAt: day(2), folderPath: "Trips/Paris", sortKey: "p2" });
    await db.insert(photoFavorites).values({ viewerId: w.member.viewer.id, titleId: b.id });
    const grid = await text(await library(req("/x"), ctx({ ...sid(w), id: lib.id })));
    expect(grid).toContain(`library/${lib.id}?view=albums"`);
    expect(grid).toContain(`library/${lib.id}?view=favorites"`);
    const after = await text(await library(req(`/x?after=${encodeURIComponent(`${Math.floor(day(2).getTime() / 1000) + 1}~ffffffff-ffff-4fff-bfff-ffffffffffff`)}`), ctx({ ...sid(w), id: lib.id })));
    expect(after).not.toContain("view=albums");
    const albums = await text(await library(req("/x?view=albums"), ctx({ ...sid(w), id: lib.id })));
    expect(albums).toContain("Trips");
    expect(albums).toContain(`view=albums&amp;path=Trips"`);
    const deep = await text(await library(req(`/x?view=albums&path=${encodeURIComponent("Trips/Paris")}`), ctx({ ...sid(w), id: lib.id })));
    expect(deep).toContain(`href="/tv/s/${w.server.id}/photo/${a.id}?from=album"`);
    expect(deep).toContain(`data-back href="/tv/s/${w.server.id}/library/${lib.id}?view=albums&amp;path=Trips"`);
    const favs = await text(await library(req("/x?view=favorites"), ctx({ ...sid(w), id: lib.id })));
    expect(favs).toContain(`/photo/${b.id}?from=favorites`);
    expect(favs).not.toContain(`/photo/${a.id}`);
    expect((await library(req("/x?view=albums&path=Nope"), ctx({ ...sid(w), id: lib.id }))).status).toBe(404);
  });
  it("pages the albums root with a working link (the second page is the same view, not the timeline)", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    for (let i = 0; i < 26; i++) await makeTitle(db, lib.id, { kind: "photo", name: `Loose ${String(i).padStart(2, "0")}`, takenAt: day(1), folderPath: "", sortKey: `loose ${String(i).padStart(2, "0")}` });
    const first = await text(await library(req("/x?view=albums"), ctx({ ...sid(w), id: lib.id })));
    const more = /data-more href="([^"]+)"/.exec(first)![1].replace(/&amp;/g, "&");
    expect(more).toMatch(/\?view=albums&after=/);
    const second = await text(await library(req(`/x${more.slice(more.indexOf("?"))}`), ctx({ ...sid(w), id: lib.id })));
    expect(second).toContain("Loose 25");
    expect(second).not.toContain("Loose 00");
    expect(second).toContain("Albums"); // still the albums view
  });
  it("sends Back from a clip to the favourites or album it was opened from", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Clip", takenAt: day(5), folderPath: "Trips", sortKey: "c" });
    await db.insert(photoFavorites).values({ viewerId: w.member.viewer.id, titleId: clip.id });
    const backOf = async (q: string) => JSON.parse(/id="play-config">(.*?)<\/script>/.exec(await text(await watch(req(`/x${q}`), ctx({ ...sid(w), kind: "title", id: clip.id }))))![1]).back;
    expect(await backOf("?from=favorites")).toBe(`/tv/s/${w.server.id}/library/${lib.id}?view=favorites`);
    expect(await backOf("?from=album")).toBe(`/tv/s/${w.server.id}/library/${lib.id}?view=albums&path=Trips`);
    expect(await backOf("")).toContain(`/library/${lib.id}?after=`);
    expect(await backOf("?from=nonsense")).toContain(`/library/${lib.id}?after=`);
    // the grids link their clips with where they came from
    const favs = await text(await library(req("/x?view=favorites"), ctx({ ...sid(w), id: lib.id })));
    expect(favs).toContain(`/watch/title/${clip.id}?from=favorites`);
    const album = await text(await library(req("/x?view=albums&path=Trips"), ctx({ ...sid(w), id: lib.id })));
    expect(album).toContain(`/watch/title/${clip.id}?from=album`);
    const moved = await photo(req("/x?from=album"), ctx({ ...sid(w), id: clip.id }));
    expect(moved.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/watch/title/${clip.id}?from=album`);
  });
  it("steps through one album and Back returns to it; favourites step through hearts and Back returns there", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const a = await makeTitle(db, lib.id, { kind: "photo", name: "A", takenAt: day(1), folderPath: "X", sortKey: "a" });
    const b = await makeTitle(db, lib.id, { kind: "photo", name: "B", takenAt: day(2), folderPath: "X", sortKey: "b" });
    await makeTitle(db, lib.id, { kind: "photo", name: "C", takenAt: day(3), folderPath: "Y", sortKey: "c" });
    const inAlbum = await text(await photo(req("/x?from=album"), ctx({ ...sid(w), id: a.id })));
    expect(inAlbum).toContain(`"next":"/tv/s/${w.server.id}/photo/${b.id}?from=album"`);
    expect(inAlbum).toContain(`"back":"/tv/s/${w.server.id}/library/${lib.id}?view=albums&path=X"`);
    expect(await text(await photo(req("/x?from=album"), ctx({ ...sid(w), id: b.id })))).toContain('"next":null');
    await db.insert(photoFavorites).values({ viewerId: w.member.viewer.id, titleId: a.id });
    const fav = await text(await photo(req("/x?from=favorites"), ctx({ ...sid(w), id: a.id })));
    expect(fav).toContain(`"back":"/tv/s/${w.server.id}/library/${lib.id}?view=favorites"`);
    expect(fav).toContain('"next":null');
  });
});

describe("slideshow polish and the screensaver", () => {
  const day = (d: number) => new Date(Date.UTC(2024, 4, d, 12));
  it("tells the viewer which picture to fetch next, and marks a screensaver so it never ends", async () => {
    const w = await world();
    const lib = await w.lib("photos");
    const a = await makeTitle(db, lib.id, { kind: "photo", name: "A", takenAt: day(1) });
    const b = await makeTitle(db, lib.id, { kind: "photo", name: "B", takenAt: day(2) });
    const normal = JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x"), ctx({ ...sid(w), id: b.id }))))![1]);
    expect(normal).toMatchObject({ nextImage: `/api/photos/${a.id}/preview`, saver: false, next: `/tv/s/${w.server.id}/photo/${a.id}` });
    const saver = JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x?saver=1"), ctx({ ...sid(w), id: b.id }))))![1]);
    expect(saver).toMatchObject({ saver: true, back: `/tv/s/${w.server.id}`, next: `/tv/s/${w.server.id}/photo/${a.id}?saver=1` });
    // the last picture of a screensaver starts over at a random one; an ordinary slideshow just ends
    const last = JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x?saver=1"), ctx({ ...sid(w), id: a.id }))))![1]);
    expect(last.next).toBe(`/tv/s/${w.server.id}/screensaver`);
    // a screensaver never steps into a video clip: it starts over instead
    const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Clip", takenAt: day(3) });
    const beforeClip = JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x?saver=1"), ctx({ ...sid(w), id: b.id }))))![1]);
    expect(beforeClip.prev).toBeNull();
    expect(JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x"), ctx({ ...sid(w), id: b.id }))))![1]).prev).toBe(`/tv/s/${w.server.id}/watch/title/${clip.id}`);
    expect(JSON.parse(/id="photo-config">(.*?)<\/script>/.exec(await text(await photo(req("/x"), ctx({ ...sid(w), id: a.id }))))![1]).next).toBeNull();
  });
  it("starts at a random picture, only from pictures this profile may see, and returns home when there are none", async () => {
    const w = await world();
    const home302 = await screensaver(req("/x"), ctx(sid(w)));
    expect([home302.status, home302.headers.get("location")]).toEqual([302, `https://roam.example/tv/s/${w.server.id}`]);
    const lib = await w.lib("photos");
    const ok = await makeTitle(db, lib.id, { kind: "photo", name: "OK", takenAt: day(1) });
    await makeTitle(db, lib.id, { kind: "movie", name: "A clip", takenAt: day(2) });
    const r = await screensaver(req("/x"), ctx(sid(w)));
    expect(r.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/photo/${ok.id}?saver=1#slide`);
    const other = await world();
    await makeTitle(db, (await other.lib("photos")).id, { kind: "photo", name: "Theirs", takenAt: day(1) });
    await signIn(w.member);
    expect((await screensaver(req("/x"), ctx(sid(w)))).headers.get("location")).toContain(ok.id);
    expect((await screensaver(req("/x"), ctx(sid(other)))).status).toBe(404);
    expect((await screensaver(req("/x"), ctx({ serverId: "nope" }))).status).toBe(404);
  });
  it("offers the screensaver on the home screen only when there is a photo library", async () => {
    const w = await world();
    expect(await text(await home(req("/x"), ctx(sid(w))))).not.toContain("data-saver=");
    await w.lib("photos");
    expect(await text(await home(req("/x"), ctx(sid(w))))).toContain(`data-saver="/tv/s/${w.server.id}/screensaver" data-saver-after="300"`);
  });
});

describe("the home screen", () => {
  it("names every kind, shows continue listening for books, and counts only what has no TV interface", async () => {
    const w = await world();
    for (const kind of ["video", "audio", "music", "photos", "audiobooks"] as const) await w.lib(kind);
    await w.lib("ebooks");
    const body = await text(await home(req("/x"), ctx(sid(w))));
    for (const label of ["Videos", "Audio", "Music", "Photos", "Audiobooks"]) expect(body).toContain(`<small>${label}</small>`);
    expect(body).toContain("1 more library isn't available on TV yet");
  });
  it("shows a Recently added row that links each item to its page", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Fresh <Film>" });
    const body = await text(await home(req("/x"), ctx(sid(w))));
    expect(body).toContain("Recently added");
    expect(body).toContain("Fresh &lt;Film&gt;");
    expect(body).toContain(`href="/tv/s/${w.server.id}/title/${film.id}"`);
  });
});
