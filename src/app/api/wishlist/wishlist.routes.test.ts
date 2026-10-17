/** The shared wishlist through the API: who can look, add, want, claim and remove. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
  tmdb: { movies: [] as unknown[], shows: [] as unknown[], fail: false },
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
vi.mock("@/lib/tmdb/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/tmdb/client")>()),
  searchMovies: async () => (h.tmdb.fail ? Promise.reject(new Error("down")) : h.tmdb.movies),
  searchTvShows: async () => (h.tmdb.fail ? Promise.reject(new Error("down")) : h.tmdb.shows),
}));

import { viewers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as list, POST as add } from "../servers/[serverId]/wishlist/route";
import { GET as search } from "../servers/[serverId]/wishlist/search/route";
import { DELETE, PATCH } from "./[id]/route";
import { PUT as want } from "./[id]/want/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  h.tmdb = { movies: [], shows: [], fail: false };
});
afterEach(() => vi.unstubAllGlobals());

const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const send = (method: string, body?: unknown, url = "https://roam.example/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (who: Awaited<ReturnType<typeof makeAccount>>, viewerId?: string) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, viewerId ? { ...who.viewer, id: viewerId } : who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `wradmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const a = await makeAccount(db, `wra${++n}`);
  const b = await makeAccount(db, `wrb${++n}`);
  await joinServer(db, server.id, a.accountId);
  await joinServer(db, server.id, b.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  return { admin, server, a, b, movies, sid: { serverId: server.id } };
}
const wishes = async (w: Awaited<ReturnType<typeof world>>) => (await json(await list(send("GET"), ctx(w.sid)))).items as { id: string; title: string; wants: number; status: string; canRemove: boolean }[];

describe("the wishlist API", () => {
  it("lets a member add wishes and see them, and a second household's request for the same thing becomes a want", async () => {
    const w = await world();
    await as(w.a);
    const made = await add(send("POST", { kind: "audiobook", title: "Project Hail Mary", creator: "Andy Weir", note: "Ray Porter reads it" }), ctx(w.sid));
    expect(made.status).toBe(201);
    await as(w.b);
    const joined = await add(send("POST", { kind: "audiobook", title: "project hail mary" }), ctx(w.sid));
    expect(joined.status).toBe(200);
    expect((await json(joined)).joined).toBe(true);
    const items = await wishes(w);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Project Hail Mary", wants: 2, canRemove: false });
    expect((await json(await list(send("GET"), ctx(w.sid)))).canEdit).toBe(true);
  });

  it("refuses strangers, signed-out visitors, bad requests, and a child's profile changing anything", async () => {
    const w = await world();
    const stranger = await makeAccount(db, `wrs${++n}`);
    await as(stranger);
    expect((await list(send("GET"), ctx(w.sid))).status).toBe(404);
    expect((await add(send("POST", { kind: "movie", title: "X" }), ctx(w.sid))).status).toBe(404);
    h.headers = {};
    expect((await list(send("GET"), ctx(w.sid))).status).toBe(404);
    await as(w.a);
    expect((await add(send("POST", { kind: "movie" }), ctx(w.sid))).status).toBe(400);
    expect((await add(send("POST", { kind: "movie", title: "X", extra: 1 }), ctx(w.sid))).status).toBe(400);
    expect((await add(send("POST", { kind: "game", title: "Zelda" }), ctx(w.sid))).status).toBe(400);
    expect((await list(send("GET"), ctx({ serverId: "nope" }))).status).toBe(404);
    // a child's profile on the account can look, not change
    const [kid] = await db.insert(viewers).values({ accountId: w.a.accountId, name: "Kid", role: "limited", sortOrder: 5 }).returning();
    await as(w.a, kid.id);
    expect((await list(send("GET"), ctx(w.sid))).status).toBe(200);
    expect((await json(await list(send("GET"), ctx(w.sid)))).canEdit).toBe(false);
    expect((await add(send("POST", { kind: "movie", title: "Nope" }), ctx(w.sid))).status).toBe(403);
    await db.delete(viewers).where(eq(viewers.id, kid.id));
  });

  it("says a movie already on the server is already here", async () => {
    const w = await world();
    const t = await makeTitle(db, w.movies.id, { kind: "movie", name: "Here", tmdbId: 5 }, { files: true });
    await as(w.a);
    const res = await add(send("POST", { kind: "movie", title: "Here", tmdbId: 5 }), ctx(w.sid));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ titleId: t.id });
  });

  it("lets households want, claim and finish, and only the right people remove", async () => {
    const w = await world();
    await as(w.a);
    const id = (await json(await add(send("POST", { kind: "show", title: "Severance" }), ctx(w.sid)))).id as string;
    await as(w.b);
    expect((await want(send("PUT", { on: true }), ctx({ id }))).status).toBe(200);
    expect((await PATCH(send("PATCH", { action: "claim" }), ctx({ id }))).status).toBe(200);
    expect((await wishes(w))[0]).toMatchObject({ wants: 2, status: "claimed" });
    await as(w.a);
    expect((await PATCH(send("PATCH", { action: "claim" }), ctx({ id }))).status).toBe(409);
    expect((await PATCH(send("PATCH", { action: "got" }), ctx({ id }))).status).toBe(403);
    expect((await DELETE(send("DELETE"), ctx({ id }))).status).toBe(200); // a asked for it
    expect(await wishes(w)).toEqual([]);
    expect((await DELETE(send("DELETE"), ctx({ id }))).status).toBe(404);
  });

  it("lets the admin remove or finish anyone's wish and takes nothing from a wish on another server", async () => {
    const w = await world();
    const other = await world();
    await as(w.a);
    const id = (await json(await add(send("POST", { kind: "book", title: "Dune" }), ctx(w.sid)))).id as string;
    await as(other.a);
    expect((await PATCH(send("PATCH", { note: "mine" }), ctx({ id }))).status).toBe(404);
    expect((await want(send("PUT", { on: true }), ctx({ id }))).status).toBe(404);
    await as(w.admin);
    expect((await PATCH(send("PATCH", { action: "got" }), ctx({ id }))).status).toBe(200);
    expect((await wishes(w))[0].status).toBe("got");
    expect((await PATCH(send("PATCH", { note: "bought" }), ctx({ id }))).status).toBe(200);
    expect((await DELETE(send("DELETE"), ctx({ id }))).status).toBe(200);
    expect((await PATCH(send("PATCH", { bogus: 1 }), ctx({ id: "nope" }))).status).toBe(404);
  });
});

describe("looking up a movie or show", () => {
  it("returns TMDB's matches, marking those already wished for or already here", async () => {
    const w = await world();
    h.tmdb.movies = [
      { id: 1, title: "Alpha", release_date: "1999-05-01", poster_path: "/a.jpg", overview: "First" },
      { id: 2, title: "Beta", release_date: "2005-01-01", poster_path: null },
      { id: 3, title: "Gamma", release_date: "2010-01-01", poster_path: "/g.jpg" },
    ];
    await makeTitle(db, w.movies.id, { kind: "movie", name: "Gamma", tmdbId: 3 }, { files: true });
    await as(w.a);
    await add(send("POST", { kind: "movie", title: "Beta", year: 2005, tmdbId: 2 }), ctx(w.sid));
    const body = await json(await search(send("GET", undefined, "https://roam.example/x?q=alpha&kind=movie"), ctx(w.sid)));
    expect(body.results.map((r: { title: string; year: number | null; titleId: string | null; wishId: string | null }) => [r.title, r.year, !!r.titleId, !!r.wishId])).toEqual([["Alpha", 1999, false, false], ["Beta", 2005, false, true], ["Gamma", 2010, true, false]]);
    expect(body.results[0].posterUrl).toContain("image.tmdb.org");
  });

  it("looks up shows, ignores short or odd queries, is signed-in only, and says so when TMDB is down", async () => {
    const w = await world();
    h.tmdb.shows = [{ id: 9, name: "Show", first_air_date: "2020-01-01", poster_path: null }];
    await as(w.a);
    expect((await json(await search(send("GET", undefined, "https://roam.example/x?q=sh&kind=show"), ctx(w.sid)))).results).toHaveLength(1);
    expect((await json(await search(send("GET", undefined, "https://roam.example/x?q=s&kind=show"), ctx(w.sid)))).results).toEqual([]);
    expect((await json(await search(send("GET", undefined, "https://roam.example/x?q=show&kind=book"), ctx(w.sid)))).results).toEqual([]);
    h.tmdb.fail = true;
    expect((await search(send("GET", undefined, "https://roam.example/x?q=show&kind=show"), ctx(w.sid))).status).toBe(502);
    h.headers = {};
    expect((await search(send("GET", undefined, "https://roam.example/x?q=show&kind=show"), ctx(w.sid))).status).toBe(404);
  });
});
