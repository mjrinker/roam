/** Rating on a TV: the Your rating buttons and the route behind them. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    getCurrentServerMember: async (serverId: string) => {
      const account = h.profile as { id: string } | null;
      const resolved = h.resolution as { viewer: unknown } | null;
      if (!account || !resolved) return null;
      const [m] = await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, account.id), eq(serverMembers.serverId, serverId))).limit(1);
      return m ? { profile: account, role: m.role, viewer: resolved.viewer } : null;
    },
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";


import { GET as titlePage } from "./s/[serverId]/title/[id]/route";
import { GET as showPage } from "./s/[serverId]/show/[id]/route";
import { GET as episodePage } from "./s/[serverId]/episode/[id]/route";
import { GET as rateGet, POST as ratePost } from "./s/[serverId]/rate/route";
import { ratingsOf } from "@/lib/ratings/service";

let db: TestDb;
beforeAll(() => { db = h.testDb.db; });
beforeEach(() => { h.resolution = null; h.profile = null; h.jar.clear(); });

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => new Request("https://roam.example/x", { method: "POST", headers, body: new URLSearchParams(fields) });
const text = async (r: Response) => r.text();

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, member.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, member.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  h.profile = account;
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, lib.id, { kind: "movie", name: "Film" });
  return { server, member, film, sid: { serverId: server.id } };
}

describe("rating on a TV", () => {
  it("offers five stars on a movie's page, and says what you gave it, with a way to clear it", async () => {
    const w = await world();
    const before = await text(await titlePage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(before).toContain("Your rating");
    expect(before).toContain(`/tv/s/${w.server.id}/rate`);
    expect(before).not.toContain("Clear");
    expect((await ratePost(post({ kind: "title", id: w.film.id, stars: "4", back: `/tv/s/${w.server.id}/title/${w.film.id}` }), ctx(w.sid))).status).toBe(303);
    expect((await ratingsOf(db, w.member.viewer.id, "title", [w.film.id])).get(w.film.id)).toBe(8);
    const after = await text(await titlePage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(after).toContain("Your rating: 4 stars");
    expect(after).toContain("Clear");
    await ratePost(post({ kind: "title", id: w.film.id, stars: "0", back: "/tv" }), ctx(w.sid));
    expect((await ratingsOf(db, w.member.viewer.id, "title", [w.film.id])).size).toBe(0);
  });

  it("tells you what everyone on the server gave it when you have not rated, and your own once you have", async () => {
    const w = await world();
    const other = await makeAccount(db, "avgother");
    await joinServer(db, w.server.id, other.accountId);
    const { ratings } = await import("@/lib/db/schema");
    await db.insert(ratings).values([{ viewerId: other.viewer.id, ownerKind: "title", ownerId: w.film.id, halfStars: 9 }]);
    const page = async () => text(await titlePage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(await page()).toContain("everyone on this server gave it 4.5 on average, from 1 rating");
    await ratePost(post({ kind: "title", id: w.film.id, stars: "2" }), ctx(w.sid));
    const mine = await page();
    expect(mine).toContain("Your rating: 2 stars");
    expect(mine).not.toContain("on average");
  });

  it("shows a half-star rating made on the web as it is", async () => {
    const w = await world();
    await ratePost(post({ kind: "title", id: w.film.id, stars: "3" }), ctx(w.sid));
    const { ratings } = await import("@/lib/db/schema");
    await db.update(ratings).set({ halfStars: 7 }).where(eq(ratings.ownerId, w.film.id));
    expect(await text(await titlePage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })))).toContain("Your rating: 3.5 stars");
  });

  it("refuses nonsense, other sites, and opening the address in a browser", async () => {
    const w = await world();
    for (const stars of ["6", "-1", "2.5", "x"]) expect((await ratePost(post({ kind: "title", id: w.film.id, stars }), ctx(w.sid))).status).toBe(404);
    expect((await ratePost(post({ kind: "movie", id: w.film.id, stars: "3" }), ctx(w.sid))).status).toBe(404);
    expect((await ratePost(post({ kind: "title", id: w.film.id, stars: "3" }, { origin: "https://evil.example" }), ctx(w.sid))).status).toBe(404);
    expect((await ratingsOf(db, w.member.viewer.id, "title", [w.film.id])).size).toBe(0);
    expect((await rateGet(new Request("https://roam.example/x"), ctx(w.sid))).status).toBe(302);
  });
});

describe("rating an episode on a TV", () => {
  async function showWorld() {
    const w = await world();
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const { show, episodes } = await makeShow(db, shows.id, 2, { name: "The Show" });
    return { ...w, show, episodes };
  }
  const get = (page: (r: Request, c: never) => Promise<Response>, sid: Record<string, string>, id: string) => page(new Request("https://roam.example/x"), ctx({ ...sid, id }));

  it("lists the episodes on the show's page with what you gave each, each opening its own page", async () => {
    const w = await showWorld();
    await ratePost(post({ kind: "episode", id: w.episodes[0].id, stars: "4" }), ctx(w.sid));
    const page = await text(await get(showPage, w.sid, w.show.id));
    expect(page).toContain("Rate or mark an episode");
    expect(page).toContain("Your rating: 4");
    expect(page).toContain("Not rated");
    expect(page).toContain(`/tv/s/${w.server.id}/episode/${w.episodes[0].id}`);
  });

  it("has a page for an episode to play it, mark it watched and rate it", async () => {
    const w = await showWorld();
    const e = w.episodes[1];
    const page = await text(await get(episodePage, w.sid, e.id));
    expect(page).toContain("Ep 2");
    expect(page).toContain("The Show");
    expect(page).toContain(`/tv/s/${w.server.id}/watch/episode/${e.id}`);
    expect(page).toContain("Mark as watched");
    expect(page).toContain("Your rating");
    expect(page).toContain(`/tv/s/${w.server.id}/show/${w.show.id}?season=1`);
    await ratePost(post({ kind: "episode", id: e.id, stars: "2", back: `/tv/s/${w.server.id}/episode/${e.id}` }), ctx(w.sid));
    expect(await text(await get(episodePage, w.sid, e.id))).toContain("Your rating: 2 stars");
  });

  it("is not found for an episode on another server, or a bad id", async () => {
    const other = await showWorld();
    const w = await showWorld();
    expect((await get(episodePage, w.sid, other.episodes[0].id)).status).toBe(404);
    expect((await get(episodePage, w.sid, "nope")).status).toBe(404);
  });
});
