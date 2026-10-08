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
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { musicAlbums, musicArtists, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as home } from "./s/[serverId]/route";
import { GET as library } from "./s/[serverId]/library/[id]/route";
import { GET as book } from "./s/[serverId]/book/[id]/route";
import { GET as listen } from "./s/[serverId]/listen/[id]/route";
import { GET as artist } from "./s/[serverId]/artist/[id]/route";
import { GET as album } from "./s/[serverId]/album/[id]/route";
import { GET as photo } from "./s/[serverId]/photo/[id]/route";
import { GET as watch } from "./s/[serverId]/watch/[kind]/[id]/route";
import { GET as title } from "./s/[serverId]/title/[id]/route";
import { GET as search } from "./s/[serverId]/search/route";

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
    expect(cfg.queue).toEqual({ items: [{ id: songs[0].id, title: "Intro", by: "The Band" }, { id: songs[1].id, title: "Song <2>", by: "The Band" }], index: 0 });
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
