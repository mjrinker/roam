/** GET /api/music/radio: who can ask, and what comes back, with the outside services stubbed. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET } from "./route";

let db: TestDb;
const MB1 = "00000000-0000-4000-8000-000000000001";
const MB2 = "00000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("musicbrainz.org/ws/2/artist/")) return new Response(JSON.stringify({ name: "Seed", relations: [] }));
    if (url.includes("listenbrainz.org")) return new Response(JSON.stringify([{ artist_mbid: MB2, name: "Friend", score: 9 }]));
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const get = (query: string) => GET(new Request(`https://roam.example/api/music/radio?${query}`));

let n = 0;
async function world() {
  const admin = await makeAccount(db, `radmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `rmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  async function artist(name: string, mbid: string) {
    const [a] = await db.insert(musicArtists).values({ libraryId: lib.id, name, nameKey: `${name}${n}`.toLowerCase(), sortKey: name.toLowerCase(), mbid }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: a.id, name: `${name} album`, nameKey: `${a.id}x` }).returning();
    const songs: string[] = [];
    for (let i = 0; i < 4; i++) songs.push((await db.insert(titles).values({ libraryId: lib.id, kind: "audiobook", name: `${name} ${i}`, boxFolderId: `${a.id}${i}`, albumId: al.id }).returning())[0].id);
    return { ...a, songs };
  }
  return { member, artist };
}

describe("GET /api/music/radio", () => {
  it("gives a member a radio from an artist, and from a song that starts with it", async () => {
    const w = await world();
    const seed = await w.artist("Seed", MB1);
    const friend = await w.artist("Friend", MB2);
    await as(w.member);
    const res = await get(`artist=${seed.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: string[]; artistName: string; fromArtists: number };
    expect(body.artistName).toBe("Seed");
    expect(body.ids.length).toBe(8);
    expect(new Set(body.ids)).toEqual(new Set([...seed.songs, ...friend.songs]));
    const fromSong = (await (await get(`song=${seed.songs[2]}`)).json()) as { ids: string[] };
    expect(fromSong.ids[0]).toBe(seed.songs[2]);
  });

  it("is the same 404 for bad requests, strangers, unknown ids, and being signed out", async () => {
    const w = await world();
    const seed = await w.artist("Seed", MB1);
    await as(w.member);
    for (const q of ["", "artist=nope", `artist=${seed.id}&song=${seed.songs[0]}`, "song=123e4567-e89b-42d3-a456-426614174000", "artist=123e4567-e89b-42d3-a456-426614174000"]) {
      expect((await get(q)).status).toBe(404);
    }
    const stranger = await makeAccount(db, `rstranger${++n}`);
    await as(stranger);
    expect((await get(`artist=${seed.id}`)).status).toBe(404);
    h.headers = {};
    expect((await get(`artist=${seed.id}`)).status).toBe(404);
  });
});
