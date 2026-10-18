/** A profile's Trakt connection: stored encrypted, refreshed when it runs out, used to send finishes and ratings and to bring history in. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { traktLinks } from "@/lib/db/schema";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { Trakt } from "./client";
import { freshToken, linkOf, pullFromTrakt, pushRating, pushWatched, saveLink, unlink } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const NOW = new Date("2026-10-18T12:00:00Z");
function fake(answers: Record<string, () => Response> = {}) {
  const calls: { path: string; body: unknown; auth?: string }[] = [];
  const client = new Trakt({ clientId: "c", clientSecret: "s" }, async (url, init) => {
    const path = url.replace("https://api.trakt.tv", "");
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.Authorization });
    return answers[path]?.() ?? Response.json({}, { status: path.startsWith("/sync/watched") || path.startsWith("/sync/ratings") ? 200 : 404 });
  }, () => NOW);
  return { client, calls };
}

async function world(name: string) {
  const admin = await makeAccount(db, `${name}a`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `${name}m`);
  await joinServer(db, server.id, me.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  return { server, me, movies, shows };
}

describe("the stored connection", () => {
  it("keeps tokens encrypted, hands back a fresh one, and refreshes one that is about to run out", async () => {
    const w = await world("tk1");
    const v = w.me.viewer.id;
    await saveLink(db, v, { accessToken: "ACCESS", refreshToken: "REFRESH", expiresAt: new Date(NOW.getTime() + 3600_000) }, "ann");
    const [raw] = await db.select().from(traktLinks).where(eq(traktLinks.viewerId, v));
    expect(raw.accessTokenEncrypted).not.toContain("ACCESS");
    expect((await linkOf(db, v))?.username).toBe("ann");
    const { client, calls } = fake();
    expect(await freshToken(db, client, v, NOW)).toBe("ACCESS");
    expect(calls).toEqual([]);
    await saveLink(db, v, { accessToken: "OLD", refreshToken: "REFRESH", expiresAt: new Date(NOW.getTime() + 60_000) }, "ann");
    const refreshing = fake({ "/oauth/token": () => Response.json({ access_token: "NEW", refresh_token: "R2", expires_in: 7200 }) });
    expect(await freshToken(db, refreshing.client, v, NOW)).toBe("NEW");
    expect(await freshToken(db, refreshing.client, v, new Date(NOW.getTime() + 1000))).toBe("NEW"); // kept, no second refresh
    expect(refreshing.calls.filter((c) => c.path === "/oauth/token")).toHaveLength(1);
    await unlink(db, v);
    expect(await linkOf(db, v)).toBeNull();
    expect(await freshToken(db, client, v, NOW)).toBeNull();
  });
});

describe("sending what is finished and rated", () => {
  it("sends a finished movie and an episode, and a rating, only for a connected profile", async () => {
    const w = await world("tk2");
    const heat = await makeTitle(db, w.movies.id, { kind: "movie", name: "Heat", year: 1995, tmdbId: 949 });
    const { show, episodes: eps } = await makeShow(db, w.shows.id, 2, { name: "Lost", year: 2004, tmdbId: 4607 });
    const v = w.me.viewer.id;
    const { client, calls } = fake({ "/sync/history": () => Response.json({}), "/sync/ratings": () => Response.json({}) });
    await pushWatched(db, v, "title", heat.id, NOW, client);
    expect(calls).toEqual([]); // not connected
    await saveLink(db, v, { accessToken: "A", refreshToken: "R", expiresAt: new Date(Date.now() + 3600_000) }, null);
    await pushWatched(db, v, "title", heat.id, NOW, client);
    await pushWatched(db, v, "episode", eps[1].id, NOW, client);
    await pushRating(db, v, "title", heat.id, 9, client);
    expect(calls.map((c) => c.path)).toEqual(["/sync/history", "/sync/history", "/sync/ratings"]);
    expect(calls[0].body).toEqual({ movies: [{ ids: { tmdb: 949 }, watched_at: NOW.toISOString() }] });
    expect(calls[1].body).toMatchObject({ shows: [{ ids: { tmdb: 4607 }, seasons: [{ number: 1, episodes: [{ number: eps[1].number }] }] }] });
    expect(show.id).toBeTruthy();
  });

  it("never throws when Trakt fails", async () => {
    const w = await world("tk3");
    const heat = await makeTitle(db, w.movies.id, { kind: "movie", name: "Heat", year: 1995, tmdbId: 949 });
    const v = w.me.viewer.id;
    await saveLink(db, v, { accessToken: "A", refreshToken: "R", expiresAt: new Date(Date.now() + 3600_000) }, null);
    const { client } = fake({ "/sync/history": () => new Response("{}", { status: 500 }) });
    await expect(pushWatched(db, v, "title", heat.id, NOW, client)).resolves.toBeUndefined();
  });
});

describe("bringing history in", () => {
  it("applies the Trakt history to the profile", async () => {
    const w = await world("tk4");
    const heat = await makeTitle(db, w.movies.id, { kind: "movie", name: "Heat", year: 1995, tmdbId: 949 });
    const v = w.me.viewer.id;
    await saveLink(db, v, { accessToken: "A", refreshToken: "R", expiresAt: new Date(Date.now() + 3600_000) }, null);
    const { client } = fake({
      "/sync/watched/movies": () => Response.json([{ last_watched_at: "2025-05-05T00:00:00Z", movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } } }, { movie: { title: "Elsewhere", year: 2000, ids: { tmdb: 1 } } }]),
      "/sync/watched/shows": () => Response.json([]),
      "/sync/ratings/movies": () => Response.json([{ rating: 8, movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } } }]),
      "/sync/ratings/shows": () => Response.json([]),
    });
    const scope = { actor: { serverId: w.server.id, accountId: w.me.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: v, serverId: w.server.id };
    const result = await pullFromTrakt(db, scope, client);
    expect(result).toMatchObject({ watched: 1, ratings: 1, notFound: { total: 1, sample: ["Elsewhere (2000)"] } });
    expect(heat.id).toBeTruthy();
    await unlink(db, v);
    expect(await pullFromTrakt(db, scope, client)).toBeNull();
  });
});
