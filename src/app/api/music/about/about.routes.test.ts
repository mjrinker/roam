/** GET /api/music/about/[kind]/[id]: who can ask, and what comes back, with the outside services stubbed. */
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

import { eq } from "drizzle-orm";
import { libraries, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET } from "./[kind]/[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("musicbrainz.org/ws/2/artist/")) return new Response(JSON.stringify({ name: "Band", relations: [{ type: "wikipedia", url: { resource: "https://en.wikipedia.org/wiki/The_Band" } }] }));
    if (url.includes("musicbrainz.org/ws/2/release/")) return new Response(JSON.stringify({ "release-group": { id: "00000000-0000-4000-8000-0000000000aa", title: "Record" } }));
    if (url.includes("musicbrainz.org/ws/2/release-group/")) return new Response(JSON.stringify({ title: "Record", relations: [{ type: "wikipedia", url: { resource: "https://en.wikipedia.org/wiki/Record_(album)" } }] }));
    if (url.includes("wikipedia.org/api/rest_v1")) return new Response(JSON.stringify({ type: "standard", title: "The Band", extract: "A band.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/The_Band" } } }));
    if (url.includes("listenbrainz.org")) return new Response(JSON.stringify([{ artist_mbid: "00000000-0000-4000-8000-0000000000bb", name: "Cousins", score: 9 }]));
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const get = (kind: string, id: string) => GET(new Request("https://roam.example/x"), { params: Promise.resolve({ kind, id }) } as never);

let n = 0;
async function world(lookups = true) {
  const admin = await makeAccount(db, `mabout${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `mmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  if (!lookups) await db.update(libraries).set({ musicLookup: false }).where(eq(libraries.id, lib.id));
  const [artist] = await db.insert(musicArtists).values({ libraryId: lib.id, name: "Band", nameKey: `band${n}`, sortKey: "band", mbid: "00000000-0000-4000-8000-000000000001" }).returning();
  const [album] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: artist.id, name: "Record", nameKey: `record${n}`, mbid: "00000000-0000-4000-8000-000000000002", matchStatus: "matched" }).returning();
  await db.insert(titles).values({ libraryId: lib.id, kind: "audiobook", name: "Song", boxFolderId: `s${n}`, albumId: album.id });
  return { member, artist, album };
}

describe("GET /api/music/about", () => {
  it("gives a member the description of an artist and of an album", async () => {
    const w = await world();
    await as(w.member);
    const artist = await get("artist", w.artist.id);
    expect(artist.status).toBe(200);
    expect(await artist.json()).toMatchObject({ found: true, summary: "A band.", sourceTitle: "The Band", similarInLibrary: [], similarElsewhere: ["Cousins"] });
    const album = await get("album", w.album.id);
    expect(await album.json()).toMatchObject({ found: true, summary: "A band." });
  });

  it("is the same 404 for strangers, a bad kind or id, and a library with lookups off", async () => {
    const w = await world();
    const off = await world(false);
    await as(w.member);
    expect((await get("song", w.artist.id)).status).toBe(404);
    expect((await get("artist", "nope")).status).toBe(404);
    expect((await get("artist", "123e4567-e89b-42d3-a456-426614174000")).status).toBe(404);
    expect((await get("artist", off.artist.id)).status).toBe(404); // another server this member is not in
    await as(off.member);
    expect((await get("artist", off.artist.id)).status).toBe(404); // lookups are off here
    expect((await get("album", off.album.id)).status).toBe(404);
    const stranger = await makeAccount(db, `mstranger${++n}`);
    await as(stranger);
    expect((await get("artist", w.artist.id)).status).toBe(404);
    h.headers = {};
    expect((await get("artist", w.artist.id)).status).toBe(404); // signed out
  });
});
