/** Subtitle routes: who may see, add, search for and remove subtitles, and what is kept. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, subtitleTracks, titles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { MAX_TRACKS_PER_OWNER } from "@/lib/subtitles/service";
import { GET as list, POST as upload } from "./route";
import { DELETE as remove, GET as cues } from "./[id]/route";
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

const filmOwner = (id: string) => ({ ownerKind: "title", ownerId: id });
const form = (fields: Record<string, string | File>, headers: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return new Request("http://x/api/subtitles", { method: "POST", body: f, headers });
};
const srtFile = (text = SRT, name = "film.srt") => new File([text], name, { type: "application/x-subrip" });
const listFor = (id: string, kind = "title") => list(new Request(`http://x/api/subtitles?ownerKind=${kind}&ownerId=${id}`));
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const rowsFor = (titleId: string) => db.select().from(subtitleTracks).where(eq(subtitleTracks.titleId, titleId));

describe("uploading a subtitle file", () => {
  it("keeps only the words and timing, normalizes the language, labels it, and lists it", async () => {
    const w = await world();
    const res = await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "EN" }));
    expect([res.status, (await res.json()).cues]).toEqual([201, 2]);
    const [row] = await rowsFor(w.film.id);
    expect(row).toMatchObject({ language: "en", label: "English", source: "upload", externalId: null, cueCount: 2, hearingImpaired: false });
    expect(row.cues).toEqual([[1, 3, "Hello there"], [4, 5.5, "Second line"]]);
    const listed = await (await listFor(w.film.id)).json();
    expect(listed.tracks).toEqual([{ id: row.id, language: "en", label: "English", source: "upload", hearingImpaired: false, cueCount: 2 }]);
    expect(listed.canManage).toBe(true);
  });
  it("takes a typed label, a region in the language, and marks hearing-impaired tracks", async () => {
    const w = await world();
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "pt-br", label: "  Director's   cut\n" }));
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en", hearingImpaired: "true" }));
    const rows = await rowsFor(w.film.id);
    expect(rows.map((r) => [r.language, r.label, r.hearingImpaired]).sort()).toEqual([["en", "English (SDH)", true], ["pt-BR", "Director's Cut".replace("Cut", "cut"), false]]);
  });
  it("is the same 404 for a member who isn't the admin, and for a title they can't see, and adds nothing", async () => {
    const w = await world();
    const hidden = await world("restricted"); // (its own server and admin)
    await w.asMember();
    expect((await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }))).status).toBe(404);
    // a library this member was not given: restricted, and they are not in it
    await db.update((await import("@/lib/db/schema")).libraries).set({ access: "restricted" }).where(eq((await import("@/lib/db/schema")).libraries.id, w.movies.id));
    expect((await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }))).status).toBe(404);
    expect((await upload(form({ ...filmOwner(hidden.film.id), file: srtFile(), language: "en" }))).status).toBe(404); // another server entirely
    expect(await rowsFor(w.film.id)).toEqual([]);
    expect(await rowsFor(hidden.film.id)).toEqual([]);
  });
  it("refuses a bad request with a message: no file, no language, not subtitles, empty, too big, not a form", async () => {
    const w = await world();
    const cases: [Request, number, string][] = [
      [form({ ...filmOwner(w.film.id), language: "en" }), 400, "Choose a subtitle file"],
      [form({ ...filmOwner(w.film.id), file: srtFile() }), 400, "language"],
      [form({ ...filmOwner(w.film.id), file: srtFile(), language: "english please" }), 400, "language"],
      [form({ ...filmOwner(w.film.id), file: srtFile("just some words"), language: "en" }), 400, "doesn't look like a subtitle"],
      [form({ ...filmOwner(w.film.id), file: srtFile(""), language: "en" }), 400, "empty"],
      [form({ ...filmOwner(w.film.id), file: srtFile("x".repeat(2 * 1024 * 1024 + 10)), language: "en" }), 400, "too large"],
      [new Request("http://x/api/subtitles", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), 415, "form upload"],
      [form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }, { "content-length": String(50 * 1024 * 1024) }), 413, "too large"],
    ];
    for (const [req, status, text] of cases) {
      const res = await upload(req);
      expect([res.status, (await res.json()).error], text).toEqual([status, expect.stringContaining(text)]);
    }
    expect(await rowsFor(w.film.id)).toEqual([]);
  });
  it("holds at most 20 tracks per title, then says so", async () => {
    const w = await world();
    for (let i = 0; i < MAX_TRACKS_PER_OWNER; i++) expect((await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en", label: `T${i}` }))).status).toBe(201);
    const over = await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }));
    expect([over.status, (await over.json()).error]).toEqual([409, expect.stringContaining("20")]);
  });
  it("works for an episode too, and not for pictures or songs", async () => {
    const w = await world();
    const { episodes: eps } = await makeShow(db, (await w.lib("shows")).id, 1, { name: "Show" });
    expect((await upload(form({ ownerKind: "episode", ownerId: eps[0].id, file: srtFile(), language: "en" }))).status).toBe(201);
    const clip = await makeTitle(db, (await w.lib("photos")).id, { kind: "movie", name: "Clip", takenAt: new Date() });
    expect((await upload(form({ ...filmOwner(clip.id), file: srtFile(), language: "en" }))).status).toBe(404);
    expect((await upload(form({ ownerKind: "show", ownerId: w.film.id, file: srtFile(), language: "en" }))).status).toBe(404);
  });
});

describe("listing and reading tracks", () => {
  it("lets any member who can watch it list the tracks and read their cues (and says they can't manage)", async () => {
    const w = await world();
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }));
    const [row] = await rowsFor(w.film.id);
    await w.asMember();
    const listed = await (await listFor(w.film.id)).json();
    expect([listed.tracks.length, listed.canManage]).toEqual([1, false]);
    const res = await cues(new Request("http://x"), idCtx(row.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(await res.json()).toEqual({ id: row.id, language: "en", label: "English", cues: [[1, 3, "Hello there"], [4, 5.5, "Second line"]] });
  });
  it("never shows another server's, a hidden library's or an age-limited title's subtitles", async () => {
    const w = await world();
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }));
    const [row] = await rowsFor(w.film.id);
    const other = await world();
    await other.asMember(); // signed in on a different server entirely
    expect((await listFor(w.film.id)).status).toBe(404);
    expect((await cues(new Request("http://x"), idCtx(row.id))).status).toBe(404);
    await w.asMember();
    await db.update(titles).set({ ratingAges: { ANY: 17 } }).where(eq(titles.id, w.film.id));
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.accountId, w.member.accountId));
    await w.asMember();
    expect((await listFor(w.film.id)).status).toBe(404);
    expect((await cues(new Request("http://x"), idCtx(row.id))).status).toBe(404);
  });
  it("answers 404 for malformed or unknown ids", async () => {
    await world();
    for (const bad of ["nope", "00000000-0000-4000-8000-0000000000aa"]) expect((await cues(new Request("http://x"), idCtx(bad))).status).toBe(404);
    expect((await list(new Request("http://x/api/subtitles?ownerKind=title&ownerId=nope"))).status).toBe(404);
    expect((await list(new Request("http://x/api/subtitles"))).status).toBe(404);
  });
});

describe("removing a track", () => {
  it("is for the admin only, and a title leaving takes its subtitles with it", async () => {
    const w = await world();
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }));
    const [row] = await rowsFor(w.film.id);
    await w.asMember();
    expect((await remove(new Request("http://x", { method: "DELETE" }), idCtx(row.id))).status).toBe(404);
    expect(await rowsFor(w.film.id)).toHaveLength(1);
    await w.asAdmin();
    expect((await remove(new Request("http://x", { method: "DELETE" }), idCtx(row.id))).status).toBe(200);
    expect(await rowsFor(w.film.id)).toEqual([]);
    expect((await remove(new Request("http://x", { method: "DELETE" }), idCtx(row.id))).status).toBe(404);
    await upload(form({ ...filmOwner(w.film.id), file: srtFile(), language: "en" }));
    await db.delete(titles).where(eq(titles.id, w.film.id));
    expect(await db.select().from(subtitleTracks).where(eq(subtitleTracks.titleId, w.film.id))).toEqual([]);
  });
});

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
    await w.asMember();
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
  it("fetches the file, reads it, stores it with its id, and reports the downloads left; the same file twice is refused", async () => {
    const w = await world();
    pretendOpenSubtitles();
    const res = await downloadBody({ ...filmOwner(w.film.id), fileId: 111, language: "en", hearingImpaired: true });
    expect([res.status, await res.json()]).toEqual([201, { ok: true, id: expect.any(String), cues: 2, remaining: 19, resetTime: "2026-10-10T00:00:00Z" }]);
    const [row] = await rowsFor(w.film.id);
    expect(row).toMatchObject({ source: "opensubtitles", externalId: "111", language: "en", label: "English (SDH)", hearingImpaired: true, cueCount: 2 });
    const again = await downloadBody({ ...filmOwner(w.film.id), fileId: 111, language: "en" });
    expect([again.status, (await again.json()).error]).toEqual([409, expect.stringContaining("already added")]);
    expect(await rowsFor(w.film.id)).toHaveLength(1);
  });
  it("explains the daily limit, refuses a link that leaves OpenSubtitles, and a body that isn't right", async () => {
    const w = await world();
    pretendOpenSubtitles({ downloadStatus: 406 });
    const limit = await downloadBody({ ...filmOwner(w.film.id), fileId: 1, language: "en" });
    expect([limit.status, (await limit.json()).kind]).toEqual([429, "quota"]);
    pretendOpenSubtitles({ link: "https://evil.example.com/steal" });
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 1, language: "en" })).status).toBe(502);
    pretendOpenSubtitles();
    for (const bad of [{ ...filmOwner(w.film.id), fileId: "1", language: "en" }, { ...filmOwner(w.film.id), fileId: 0, language: "en" }, { ...filmOwner(w.film.id), fileId: 1.5, language: "en" }, { ...filmOwner(w.film.id), fileId: 5, language: "??" }]) {
      expect((await downloadBody(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await downloadBody({ ownerKind: "title", ownerId: "nope", fileId: 1, language: "en" })).status).toBe(404);
    expect(await rowsFor(w.film.id)).toEqual([]);
  });
  it("is for the admin only and says nothing when OpenSubtitles isn't set up", async () => {
    const w = await world();
    pretendOpenSubtitles();
    await w.asMember();
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 111, language: "en" })).status).toBe(404);
    vi.unstubAllEnvs();
    await w.asAdmin();
    expect((await downloadBody({ ...filmOwner(w.film.id), fileId: 111, language: "en" })).status).toBe(503);
  });
});
