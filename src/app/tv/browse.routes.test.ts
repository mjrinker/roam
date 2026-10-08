/** The TV pages end to end at the route level: who gets in, what they see, and what is hidden from them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

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

import { episodes, libraryMembers, profiles, seasons, viewers, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";
import { GET as front } from "./route";
import { GET as profilesRoute, POST as selectProfile } from "./profiles/route";
import { GET as signoutGet, POST as signout } from "./signout/route";
import { GET as home } from "./s/[serverId]/route";
import { GET as library } from "./s/[serverId]/library/[id]/route";
import { GET as title } from "./s/[serverId]/title/[id]/route";
import { GET as show } from "./s/[serverId]/show/[id]/route";
import { GET as watch } from "./s/[serverId]/watch/[kind]/[id]/route";

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
  h.signedOut = 0;
});

const req = (path: string) => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const text = async (r: Response) => r.text();
const post = (path: string, fields: Record<string, string>) => new Request(`https://roam.example${path}`, { method: "POST", body: new URLSearchParams(fields) });

async function signIn(who: Awaited<ReturnType<typeof makeAccount>>, viewerOverride?: unknown) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, who.accountId));
  h.resolution = { account, viewer: viewerOverride === undefined ? all[0] : viewerOverride, viewers: all };
  h.profile = account;
}

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", access);
  const shows = await makeLibrary(db, server.id, "shows", access);
  await makeLibrary(db, server.id, "ebooks", "everyone"); // the one kind that has no TV interface
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "The Film", year: 2001, overview: "A story & more.", posterUrl: "https://img.example/film.jpg", runtimeSeconds: 5400 });
  const { show: s, season, episodes: eps } = await makeShow(db, shows.id, 2, { name: "The Show", posterUrl: "https://img.example/show.jpg" });
  await signIn(member);
  return { admin, server, member, movies, shows, film, show: s, season, eps };
}

describe("getting in", () => {
  it("sends every page to the pairing screen when signed out, and to the profile screen when no profile is chosen", async () => {
    const w = await world();
    h.resolution = null;
    const id = w.film.id;
    const results = [
      await front(req("/tv")),
      await home(req("/x"), ctx({ serverId: w.server.id })),
      await library(req("/x"), ctx({ serverId: w.server.id, id: w.movies.id })),
      await title(req("/x"), ctx({ serverId: w.server.id, id })),
      await show(req("/x"), ctx({ serverId: w.server.id, id: w.show.id })),
      await watch(req("/x"), ctx({ serverId: w.server.id, kind: "title", id })),
    ];
    expect(results.map((r) => [r.status, r.headers.get("location")])).toEqual(Array(6).fill([302, "https://roam.example/tv/pair"]));
    await signIn(w.member, null);
    for (const r of [await front(req("/tv")), await home(req("/x"), ctx({ serverId: w.server.id }))]) expect(r.headers.get("location")).toBe("https://roam.example/tv/profiles");
  });

  it("goes straight into the only server, lists several, and explains having none", async () => {
    const w = await world();
    expect((await front(req("/tv"))).headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}`);
    const second = await makeServer(db, w.member.accountId);
    const body = await text(await front(req("/tv")));
    expect(body).toContain("Choose a server");
    expect(body).toContain(`/tv/s/${second.id}`);
    const lonely = await makeAccount(db, "lonely");
    await signIn(lonely);
    expect(await text(await front(req("/tv")))).toContain("No servers yet");
  });

  it("treats a server you aren't in, a bad id and a missing page alike", async () => {
    const w = await world();
    const other = await world();
    await signIn(w.member);
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const results = [
      await home(req("/x"), ctx({ serverId: other.server.id })),
      await home(req("/x"), ctx({ serverId: "not-a-uuid" })),
      await library(req("/x"), ctx({ serverId: w.server.id, id: other.movies.id })),
      await title(req("/x"), ctx({ serverId: w.server.id, id: missing })),
      await title(req("/x"), ctx({ serverId: w.server.id, id: other.film.id })),
    ];
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });
});

describe("what a profile sees", () => {
  it("shows the home screen: continue watching first, then the libraries that have a TV interface, and a note about the rest", async () => {
    const w = await world();
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: w.film.id, positionSeconds: 500, durationSeconds: 5000 });
    const body = await text(await home(req("/x"), ctx({ serverId: w.server.id })));
    expect(body).toContain("Continue watching");
    expect(body).toContain(`/tv/s/${w.server.id}/watch/title/${w.film.id}`);
    expect(body).toContain(`/library/${w.movies.id}`);
    expect(body).toContain(`/library/${w.shows.id}`);
    expect(body).toContain("1 more library isn't available on TV yet");
    expect(body).toContain('width:10%');
    expect(body).toMatch(/<script src="\/tv\/tv\.js\?v=/);
    expect(body.match(/<script/g)).toHaveLength(1); // nothing else runs on the page
  });

  it("lists a library with links to movies and shows, and pages", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await makeTitle(db, w.movies.id, { kind: "movie", name: `Extra ${String(i).padStart(2, "0")}` });
    const one = await text(await library(req(`/x`), ctx({ serverId: w.server.id, id: w.movies.id })));
    expect(one).toContain("Extra 00");
    expect(one).not.toContain(`/title/${w.film.id}`); // "The Film" sorts onto the second page
    expect(one).toContain(`?page=2`);
    expect(one).not.toContain("Previous");
    const two = await text(await library(req(`/x?page=2`), ctx({ serverId: w.server.id, id: w.movies.id })));
    expect(two).toContain(`/tv/s/${w.server.id}/title/${w.film.id}`);
    expect(two).toContain("Previous");
    expect(two).not.toContain(">More<");
    const shows = await text(await library(req(`/x`), ctx({ serverId: w.server.id, id: w.shows.id })));
    expect(shows).toContain(`/tv/s/${w.server.id}/show/${w.show.id}`);
    expect((await library(req(`/x?page=abc`), ctx({ serverId: w.server.id, id: w.movies.id }))).status).toBe(200);
  });

  it("shows a movie with Play, or Resume with the time left", async () => {
    const w = await world();
    const fresh = await text(await title(req("/x"), ctx({ serverId: w.server.id, id: w.film.id })));
    expect(fresh).toContain(">Play<");
    expect(fresh).toContain("A story &amp; more.");
    expect(fresh).toContain("2001 · 1h 30m");
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "title", ownerId: w.film.id, positionSeconds: 1800, durationSeconds: 5400 });
    expect(await text(await title(req("/x"), ctx({ serverId: w.server.id, id: w.film.id })))).toContain("Resume (1h left)");
  });

  it("shows a show's seasons and episodes, and the right button to continue", async () => {
    const w = await world();
    const [s2] = await db.insert(seasons).values({ titleId: w.show.id, number: 2, boxFolderId: `bf${Math.random()}` }).returning();
    await db.insert(episodes).values({ seasonId: s2.id, number: 1, name: "Next Year" });
    await db.insert(watchState).values({ viewerId: w.member.viewer.id, ownerKind: "episode", ownerId: w.eps[0].id, positionSeconds: 3000, durationSeconds: 3000, finished: true });
    const body = await text(await show(req("/x"), ctx({ serverId: w.server.id, id: w.show.id })));
    expect(body).toContain("Season 1");
    expect(body).toContain("Season 2");
    expect(body).toContain(`/watch/episode/${w.eps[1].id}`); // the first unwatched episode is what Play does
    expect(body).toContain("Watched");
    const second = await text(await show(req("/x?season=2"), ctx({ serverId: w.server.id, id: w.show.id })));
    expect(second).toContain("Next Year");
  });

  it("answers ?json=1 with the next episode's details for a newer browser's Up next, and never to someone who may not see it", async () => {
    const w = await world();
    const res = await watch(req("/x?json=1"), ctx({ serverId: w.server.id, kind: "episode", id: w.eps[1].id }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ownerKind: "episode", ownerId: w.eps[1].id, back: `/tv/s/${w.server.id}/show/${w.show.id}?season=${w.season.number}`, next: null, title: "The Show", subtitle: "S1 · E2 · Ep 2", upNextSeconds: 10 });
    const first = await (await watch(req("/x?json=1"), ctx({ serverId: w.server.id, kind: "episode", id: w.eps[0].id }))).json();
    expect(first.next).toBe(`/tv/s/${w.server.id}/watch/episode/${w.eps[1].id}`);
    const other = await world();
    await signIn(w.member);
    expect((await watch(req("/x?json=1"), ctx({ serverId: w.server.id, kind: "episode", id: other.eps[0].id }))).status).toBe(404);
    expect((await watch(req("/x?json=1"), ctx({ serverId: other.server.id, kind: "episode", id: other.eps[0].id }))).status).toBe(404);
  });

  it("builds the watch page with where Back and the next episode go, and puts nothing from the library into the script", async () => {
    const w = await world();
    const ep = await text(await watch(req("/x"), ctx({ serverId: w.server.id, kind: "episode", id: w.eps[0].id })));
    const cfg = JSON.parse(/<script type="application\/json" id="play-config">(.*?)<\/script>/.exec(ep)![1]);
    expect(cfg).toEqual({ ownerKind: "episode", ownerId: w.eps[0].id, back: `/tv/s/${w.server.id}/show/${w.show.id}?season=${w.season.number}`, next: `/tv/s/${w.server.id}/watch/episode/${w.eps[1].id}` });
    const evil = await makeTitle(db, w.movies.id, { kind: "movie", name: `</script><script>alert(1)</script>` });
    const page = await text(await watch(req("/x"), ctx({ serverId: w.server.id, kind: "title", id: evil.id })));
    expect(page).not.toContain("<script>alert(1)");
    expect(page).toContain("&lt;/script&gt;");
    expect((await watch(req("/x"), ctx({ serverId: w.server.id, kind: "banana", id: evil.id }))).status).toBe(404);
  });
});

describe("what a profile does not see", () => {
  it("hides a library that wasn't shared with this member, until it is", async () => {
    const w = await world("restricted");
    const hiddenCalls = [
      await library(req("/x"), ctx({ serverId: w.server.id, id: w.movies.id })),
      await title(req("/x"), ctx({ serverId: w.server.id, id: w.film.id })),
      await show(req("/x"), ctx({ serverId: w.server.id, id: w.show.id })),
      await watch(req("/x"), ctx({ serverId: w.server.id, kind: "title", id: w.film.id })),
    ];
    expect(hiddenCalls.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(await text(await home(req("/x"), ctx({ serverId: w.server.id })))).not.toContain(`/library/${w.movies.id}`);
    await db.insert(libraryMembers).values({ libraryId: w.movies.id, serverId: w.server.id, accountId: w.member.accountId });
    expect((await title(req("/x"), ctx({ serverId: w.server.id, id: w.film.id }))).status).toBe(200);
  });
  it("hides what a profile's age limit forbids", async () => {
    const w = await world();
    const rated = await makeTitle(db, w.movies.id, { kind: "movie", name: "Rated R", ratingAges: { ANY: 17 } });
    await db.update(viewers).set({ maxAge: 7 }).where(eq(viewers.id, w.member.viewer.id));
    await signIn(w.member);
    expect((await title(req("/x"), ctx({ serverId: w.server.id, id: rated.id }))).status).toBe(404);
    expect((await watch(req("/x"), ctx({ serverId: w.server.id, kind: "title", id: rated.id }))).status).toBe(404);
    expect(await text(await library(req("/x"), ctx({ serverId: w.server.id, id: w.movies.id })))).not.toContain("Rated R");
  });
});

describe("profiles and signing out", () => {
  it("offers only profiles without a PIN, picks the only one by itself, and sets the signed profile cookie", async () => {
    const w = await world();
    await db.insert(viewers).values({ accountId: w.member.accountId, name: "Dad", role: "owner", pinHash: "x", sortOrder: 2 });
    const solo = await profilesRoute(req("/tv/profiles"));
    expect(solo.headers.get("location")).toBe("https://roam.example/tv");
    expect(h.jar.get(VIEWER_COOKIE)).toContain(w.member.viewer.id);
    h.jar.clear();
    const [kid] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Kid", role: "limited", sortOrder: 3 }).returning();
    const list = await text(await profilesRoute(req("/tv/profiles")));
    expect(list).toContain("Who&#39;s watching?");
    expect(list).toContain("Kid");
    expect(list).not.toContain("Dad");
    expect(list).toContain('method="post" action="/tv/profiles"'); // choosing is a POST
    const picked = await selectProfile(post("/tv/profiles", { viewer: kid.id }));
    expect(picked.headers.get("location")).toBe("https://roam.example/tv");
    expect(h.jar.get(VIEWER_COOKIE)).toContain(kid.id);
  });
  it("won't select a profile with a PIN, or someone else's", async () => {
    const w = await world();
    const [locked] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Locked", role: "owner", pinHash: "x", sortOrder: 2 }).returning();
    await db.insert(viewers).values({ accountId: w.member.accountId, name: "Open", role: "limited", sortOrder: 3 });
    const stranger = await makeAccount(db, "stranger");
    for (const id of [locked.id, stranger.viewer.id]) {
      h.jar.clear();
      const res = await selectProfile(post("/tv/profiles", { viewer: id }));
      expect(res.headers.get("location")).toBe("https://roam.example/tv/profiles");
      expect(h.jar.has(VIEWER_COOKIE)).toBe(false);
    }
  });
  it("needs a signed-in account, and explains when every profile is locked", async () => {
    expect((await profilesRoute(req("/tv/profiles"))).headers.get("location")).toBe("https://roam.example/tv/pair");
    expect((await selectProfile(post("/tv/profiles", { viewer: "x" }))).headers.get("location")).toBe("https://roam.example/tv/pair");
    const w = await world();
    await db.update(viewers).set({ pinHash: "x" }).where(and(eq(viewers.accountId, w.member.accountId)));
    expect(await text(await profilesRoute(req("/tv/profiles")))).toContain("Profiles with a PIN can&#39;t be used on a TV yet");
  });
  it("signs this TV out and forgets the profile, but only on a POST: opening the address just goes home", async () => {
    h.jar.set(VIEWER_COOKIE, "x");
    const link = await signoutGet(req("/tv/signout"));
    expect([link.headers.get("location"), h.signedOut, h.jar.has(VIEWER_COOKIE)]).toEqual(["https://roam.example/tv", 0, true]);
    const res = await signout(post("/tv/signout", {}));
    expect([res.status, res.headers.get("location"), h.signedOut, h.jar.has(VIEWER_COOKIE)]).toEqual([302, "https://roam.example/tv/pair", 1, false]);
  });
  it("offers Sign out on the home screen as a form button", async () => {
    const w = await world();
    const body = await text(await home(req("/x"), ctx({ serverId: w.server.id })));
    expect(body).toContain('<form method="post" action="/tv/signout"');
    expect(body).not.toContain('href="/tv/signout"');
  });
});
