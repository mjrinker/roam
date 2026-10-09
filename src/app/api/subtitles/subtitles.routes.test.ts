/** Subtitle routes: who may see, add, search for and remove subtitles, and what is kept. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as search } from "./search/route";
import { POST as download } from "./download/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SRT = "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:04,000 --> 00:00:05,500\n<i>Second</i> line\n";
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", access);
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "The Film", tmdbId: 603 });
  const asAdmin = () => signInAs(admin.accountId);
  const asMember = () => signInAs(member.accountId);
  await asAdmin();
  return { admin, member, server, movies, film, asAdmin, asMember, lib: (k: Parameters<typeof makeLibrary>[2]) => makeLibrary(db, server.id, k, access) };
}

/** A pretend OpenSubtitles on the global fetch. */
function pretendOpenSubtitles(over: { searchStatus?: number; downloadStatus?: number; link?: string } = {}) {
  const urls: string[] = [];
  vi.stubEnv("OPENSUBTITLES_API_KEY", "key");
  vi.stubEnv("OPENSUBTITLES_USERNAME", "user");
  vi.stubEnv("OPENSUBTITLES_PASSWORD", "pw");
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname === "/api/v1/login") return Response.json({ token: "tok" });
    if (u.pathname === "/api/v1/subtitles") {
      return over.searchStatus ? new Response("{}", { status: over.searchStatus }) : Response.json({ data: [{ attributes: { language: "en", download_count: 9, release: "R", files: [{ file_id: 111, file_name: "a.srt" }] } }] });
    }
    if (u.pathname === "/api/v1/download") return over.downloadStatus ? new Response("{}", { status: over.downloadStatus }) : Response.json({ link: over.link ?? "https://dl.opensubtitles.org/f/1", file_name: "a.srt", remaining: 19, reset_time: "2026-10-10T00:00:00Z" });
    if (u.hostname === "dl.opensubtitles.org") return new Response(SRT);
    return new Response("unexpected", { status: 500 });
  });
  return urls;
}
const filmOwner = (id: string) => ({ ownerKind: "title", ownerId: id });
const searchFor = (owner: { kind: string; id: string }, languages = "en") => search(new Request(`http://x/api/subtitles/search?ownerKind=${owner.kind}&ownerId=${owner.id}&languages=${languages}`));
const downloadBody = (body: unknown) => download(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("searching OpenSubtitles", () => {
  it("asks by the movie's TMDB id for the languages chosen and returns what was found", async () => {
    const w = await world();
    const urls = pretendOpenSubtitles();
    const res = await searchFor({ kind: "title", id: w.film.id }, "en,ES");
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ fileId: 111, language: "en", release: "R", fileName: "a.srt", downloads: 9, hearingImpaired: false, aiTranslated: false, trusted: false, fps: null }]);
    expect(urls.find((u) => u.includes("/subtitles?"))).toBe("https://api.opensubtitles.com/api/v1/subtitles?languages=en%2Ces&tmdb_id=603&type=movie");
  });
  it("asks for an episode by the show's TMDB id, season and episode", async () => {
    const w = await world();
    const { episodes: eps } = await makeShow(db, (await w.lib("shows")).id, 2, { name: "Show", tmdbId: 1396 });
    const urls = pretendOpenSubtitles();
    await searchFor({ kind: "episode", id: eps[1].id });
    expect(urls.find((u) => u.includes("/subtitles?"))).toBe("https://api.opensubtitles.com/api/v1/subtitles?episode_number=2&languages=en&parent_tmdb_id=1396&season_number=1&type=episode");
  });
  it("says plainly when OpenSubtitles isn't set up, is 404 for anyone but the admin, and refuses no languages", async () => {
    const w = await world();
    const none = await searchFor({ kind: "title", id: w.film.id });
    expect([none.status, (await none.json()).error]).toEqual([503, expect.stringContaining("isn't set up")]);
    pretendOpenSubtitles();
    expect((await searchFor({ kind: "title", id: w.film.id }, "!!,..")).status).toBe(400);
  });
  it("is open to a member who can watch it, and 404 for another server's title", async () => {
    const w = await world();
    pretendOpenSubtitles();
    await w.asMember();
    expect((await searchFor({ kind: "title", id: w.film.id })).status).toBe(200);
    const other = await world();
    await other.asMember();
    expect((await searchFor({ kind: "title", id: w.film.id })).status).toBe(404);
  });
  it("reports OpenSubtitles being busy or down without leaking details", async () => {
    const w = await world();
    pretendOpenSubtitles({ searchStatus: 429 });
    expect((await searchFor({ kind: "title", id: w.film.id })).status).toBe(429);
    pretendOpenSubtitles({ searchStatus: 503 });
    const down = await searchFor({ kind: "title", id: w.film.id });
    expect(down.status).toBe(502);
    expect(JSON.stringify(await down.json())).not.toContain("pw");
  });
});

describe("downloading from OpenSubtitles", () => {
  it("fetches the file and sends back its words and timing, keeping nothing", async () => {
    const w = await world();
    pretendOpenSubtitles();
    const res = await downloadBody({ ...filmOwner(w.film.id), fileId: 111 });
    expect([res.status, await res.json()]).toEqual([200, { cues: [[1, 3, "Hello there"], [4, 5.5, "Second line"]], remaining: 19, resetTime: "2026-10-10T00:00:00Z" }]);
    expect((await db.execute(sql`select to_regclass('public.subtitle_tracks') as t`)).rows[0]).toEqual({ t: null });
  });
  it("is open to any member who can watch it, and 404 for one who can't", async () => {
    const w = await world();
    pretendOpenSubtitles();
    await w.asMember();
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 111 })).status).toBe(200);
    const other = await world();
    await other.asMember();
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 111 })).status).toBe(404);
  });
  it("explains the daily limit, refuses a link that leaves OpenSubtitles, and a body that isn't right", async () => {
    const w = await world();
    pretendOpenSubtitles({ downloadStatus: 406 });
    const limit = await downloadBody({ ...filmOwner(w.film.id), fileId: 1 });
    expect([limit.status, (await limit.json()).kind]).toEqual([429, "quota"]);
    pretendOpenSubtitles({ link: "https://evil.example.com/steal" });
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 1 })).status).toBe(502);
    pretendOpenSubtitles();
    for (const bad of [{ ...filmOwner(w.film.id), fileId: "1" }, { ...filmOwner(w.film.id), fileId: 0 }, { ...filmOwner(w.film.id), fileId: 1.5 }]) {
      expect((await downloadBody(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await downloadBody({ ownerKind: "title", ownerId: "nope", fileId: 1 })).status).toBe(404);
  });
  it("says nothing helpful to guess at when OpenSubtitles isn't set up", async () => {
    const w = await world();
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 111 })).status).toBe(503);
  });
});
