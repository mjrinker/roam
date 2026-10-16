/** Rating titles, episodes and albums: who can, what is kept, and that it stays private to the profile. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { musicAlbums, musicArtists, ratings, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { ratingsOf } from "@/lib/ratings/service";
import { PUT } from "./route";
import { GET as v1Title } from "../v1/servers/[serverId]/titles/[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const rate = (body: unknown) => PUT(new Request("https://roam.example/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const mine = async (who: Awaited<ReturnType<typeof makeAccount>>, kind: "title" | "episode" | "album", id: string) => (await ratingsOf(db, who.viewer.id, kind, [id])).get(id) ?? null;

let n = 0;
async function world() {
  const admin = await makeAccount(db, `radmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `rmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const { show, episodes } = await makeShow(db, shows.id, 2, { name: "Show" });
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const photo = await makeTitle(db, photos.id, { kind: "photo", name: "Snap" });
  const music = await makeLibrary(db, server.id, "music", "everyone");
  const [artist] = await db.insert(musicArtists).values({ libraryId: music.id, name: "Band", nameKey: `band${n}`, sortKey: "band" }).returning();
  const [album] = await db.insert(musicAlbums).values({ libraryId: music.id, artistId: artist.id, name: "Record", nameKey: `record${n}` }).returning();
  return { server, member, film, show, episode: episodes[0], photo, album, sid: { serverId: server.id } };
}

describe("PUT /api/ratings", () => {
  it("rates a title, an episode and an album, changes a rating, and clears it", async () => {
    const w = await world();
    await as(w.member);
    expect((await rate({ kind: "title", id: w.film.id, halfStars: 7 })).status).toBe(200);
    expect(await mine(w.member, "title", w.film.id)).toBe(7);
    await rate({ kind: "title", id: w.film.id, halfStars: 10 });
    expect(await mine(w.member, "title", w.film.id)).toBe(10);
    await rate({ kind: "title", id: w.show.id, halfStars: 3 });
    await rate({ kind: "episode", id: w.episode.id, halfStars: 1 });
    await rate({ kind: "album", id: w.album.id, halfStars: 9 });
    expect([await mine(w.member, "title", w.show.id), await mine(w.member, "episode", w.episode.id), await mine(w.member, "album", w.album.id)]).toEqual([3, 1, 9]);
    expect((await rate({ kind: "title", id: w.film.id, halfStars: null })).status).toBe(200);
    expect(await mine(w.member, "title", w.film.id)).toBeNull();
    expect((await rate({ kind: "title", id: w.film.id, halfStars: null })).status).toBe(200); // clearing nothing is fine
  });

  it("refuses ratings that are not 1 to 10 whole half stars, and anything with extra fields", async () => {
    const w = await world();
    await as(w.member);
    for (const halfStars of [0, 11, 3.5, -1, "5", true]) expect((await rate({ kind: "title", id: w.film.id, halfStars })).status).toBe(400);
    expect((await rate({ kind: "title", id: w.film.id, halfStars: 4, viewerId: "someone-else" })).status).toBe(400);
    expect((await rate({ kind: "movie", id: w.film.id, halfStars: 4 })).status).toBe(400);
    expect((await rate({ kind: "title", id: "nope", halfStars: 4 })).status).toBe(400);
    expect(await mine(w.member, "title", w.film.id)).toBeNull();
  });

  it("is for what the profile may see: not a photo, not another server's title, not signed out", async () => {
    const w = await world();
    const other = await world();
    await as(w.member);
    expect((await rate({ kind: "title", id: w.photo.id, halfStars: 4 })).status).toBe(404);
    expect((await rate({ kind: "title", id: other.film.id, halfStars: 4 })).status).toBe(403);
    expect((await rate({ kind: "album", id: other.album.id, halfStars: 4 })).status).toBe(404);
    expect((await rate({ kind: "episode", id: other.episode.id, halfStars: 4 })).status).toBe(403);
    h.headers = {};
    expect((await rate({ kind: "title", id: w.film.id, halfStars: 4 })).status).toBe(403);
    expect(await db.select().from(ratings).where(eq(ratings.ownerId, other.film.id))).toEqual([]);
  });

  it("is each profile's own: another profile, even on the same account, does not see or change it", async () => {
    const w = await world();
    await as(w.member);
    await rate({ kind: "title", id: w.film.id, halfStars: 8 });
    const [second] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Second", role: "admin", sortOrder: 3 }).returning();
    expect((await ratingsOf(db, second.id, "title", [w.film.id])).size).toBe(0);
    await db.insert(ratings).values({ viewerId: second.id, ownerKind: "title", ownerId: w.film.id, halfStars: 2 });
    await rate({ kind: "title", id: w.film.id, halfStars: null }); // clears the signed-in profile's only
    expect(await mine(w.member, "title", w.film.id)).toBeNull();
    expect((await ratingsOf(db, second.id, "title", [w.film.id])).get(w.film.id)).toBe(2);
  });

  it("shows each episode's own rating in the show answer", async () => {
    const w = await world();
    await as(w.member);
    await rate({ kind: "episode", id: w.episode.id, halfStars: 9 });
    const body = (await (await v1Title(new Request("https://roam.example/x"), { params: Promise.resolve({ ...w.sid, id: w.show.id }) } as never)).json()) as { episodes: { id: string; myRating: number | null }[] };
    expect(body.episodes.find((e) => e.id === w.episode.id)?.myRating).toBe(9);
    expect(body.episodes.filter((e) => e.id !== w.episode.id).every((e) => e.myRating === null)).toBe(true);
  });

  it("shows up as myRating in the title API", async () => {
    const w = await world();
    await as(w.member);
    const ask = async (id: string) => ((await (await v1Title(new Request("https://roam.example/x"), { params: Promise.resolve({ ...w.sid, id }) } as never)).json()) as { myRating: number | null }).myRating;
    expect(await ask(w.film.id)).toBeNull();
    await rate({ kind: "title", id: w.film.id, halfStars: 7 });
    expect(await ask(w.film.id)).toBe(7);
  });
});
