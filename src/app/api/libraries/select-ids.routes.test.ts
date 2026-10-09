/** "Select all" for folder and music views: every id, not just the page shown, behind the same visibility rules. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { musicAlbums, musicArtists, profiles, titles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as folderIds } from "./[id]/folder-ids/route";
import { GET as musicIds } from "./[id]/music-ids/route";
import { POST as musicSongs } from "./[id]/music-songs/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const get = (route: (request: Request, ctx: never) => Promise<Response>, id: string, query: string) => route(new Request(`http://x/api?${query}`), ctx(id));
const post = (id: string, body: unknown) => musicSongs(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));

async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await signInAs(me.accountId);
  return { server, me };
}

describe("every playable file in a folder", () => {
  it("lists all of them (more than a page), in the order the folder is shown, only that folder and only playable ones", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "video", "everyone");
    const ids: string[] = [];
    for (let i = 0; i < 75; i++) ids.push((await makeTitle(db, lib.id, { kind: "movie", name: `Clip ${String(i).padStart(3, "0")}`, folderPath: "Trips", sortKey: String(i).padStart(3, "0") })).id);
    await makeTitle(db, lib.id, { kind: "movie", name: "Elsewhere", folderPath: "Other", sortKey: "000" });
    await makeTitle(db, lib.id, { kind: "photo", name: "A picture", folderPath: "Trips", sortKey: "zzz" });
    const res = await get(folderIds, lib.id, "path=Trips");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids, truncated: false });
    expect((await (await get(folderIds, lib.id, "path=")).json()).ids).toEqual([]); // the root holds nothing directly
  });
  it("leaves out what an age limit hides, and is the same 404 for a hidden library, another server's, a bad path or id", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "video", "everyone");
    const kid = await makeTitle(db, lib.id, { kind: "movie", name: "Kid", folderPath: "", ratingAges: { ANY: 0 } });
    await makeTitle(db, lib.id, { kind: "movie", name: "Adult", folderPath: "", ratingAges: { ANY: 17 } });
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.accountId, w.me.accountId));
    await signInAs(w.me.accountId);
    expect((await (await get(folderIds, lib.id, "path=")).json()).ids).toEqual([kid.id]);
    const hidden = await makeLibrary(db, w.server.id, "video", "restricted");
    const other = await world();
    const theirs = await makeLibrary(db, other.server.id, "video", "everyone");
    await signInAs(w.me.accountId);
    for (const [id, query] of [[hidden.id, "path="], [theirs.id, "path="], [lib.id, "path=../x"], ["nope", "path="]]) expect((await get(folderIds, id, query)).status, `${id} ${query}`).toBe(404);
  });
});

async function music(w: Awaited<ReturnType<typeof world>>) {
  const lib = await makeLibrary(db, w.server.id, "music", "everyone");
  const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: "band", sortKey: "band" }).returning();
  const album = async (name: string, year: number, songs: string[]) => {
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: artist.id, name, nameKey: name.toLowerCase(), year }).returning();
    const out: string[] = [];
    for (const [i, s] of songs.entries()) out.push((await makeTitle(db, lib.id, { kind: "audiobook", name: s, albumId: al.id, trackNumber: i + 1, sortKey: String(i).padStart(3, "0") })).id);
    return { id: al.id, songs: out };
  };
  return { lib, artist, album };
}

describe("every album or artist of a music library", () => {
  it("lists all of them in the order shown, and is the same 404 for anything else", async () => {
    const w = await world();
    const m = await music(w);
    const b = await m.album("Beta", 2001, ["b1"]);
    const a = await m.album("Alpha", 2000, ["a1", "a2"]);
    expect((await (await get(musicIds, m.lib.id, "view=albums")).json()).ids).toEqual([a.id, b.id]);
    expect((await (await get(musicIds, m.lib.id, "view=artists")).json()).ids).toEqual([m.artist.id]);
    for (const [id, query] of [[m.lib.id, "view=folders"], [m.lib.id, ""], ["nope", "view=albums"]]) expect((await get(musicIds, id, query)).status, `${id} ${query}`).toBe(404);
    const movies = await makeLibrary(db, w.server.id, "movies", "everyone");
    expect((await get(musicIds, movies.id, "view=albums")).status).toBe(404);
  });
});

describe("the songs of what is selected", () => {
  it("gives each album's songs in album order, an artist's songs, each song once", async () => {
    const w = await world();
    const m = await music(w);
    const late = await m.album("Late", 2005, ["l1", "l2"]);
    const early = await m.album("Early", 1995, ["e1", "e2"]);
    const res = await post(m.lib.id, { albumIds: [late.id], artistIds: [m.artist.id] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: [...late.songs, ...early.songs], truncated: false });
  });
  it("refuses an empty or malformed request, and is a 404 for a library the profile isn't in", async () => {
    const w = await world();
    const m = await music(w);
    expect((await post(m.lib.id, {})).status).toBe(400);
    expect((await post(m.lib.id, { albumIds: ["nope"] })).status).toBe(400);
    const other = await world();
    const om = await music(other);
    const album = await om.album("X", 2000, ["x1"]);
    await signInAs(w.me.accountId);
    expect((await post(om.lib.id, { albumIds: [album.id] })).status).toBe(404);
    // an album of another server asked about through one's own library yields nothing
    expect((await (await post(m.lib.id, { albumIds: [album.id] })).json()).ids).toEqual([]);
    void titles;
  });
});
