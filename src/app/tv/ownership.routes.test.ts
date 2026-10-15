/** The TV movie, show and book pages' extra sections (ownership, chapters, extras, guide), the ownership and notification routes, and starting at a chapter. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { mediaFiles, notifications, profiles, titleExtras, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { saveSettings } from "@/lib/ownership/owners";
import { hashPin } from "@/lib/viewers/pin";
import { GET as home } from "./s/[serverId]/route";
import { GET as title } from "./s/[serverId]/title/[id]/route";
import { GET as show } from "./s/[serverId]/show/[id]/route";
import { GET as watch } from "./s/[serverId]/watch/[kind]/[id]/route";

import { POST as ownership, GET as ownershipGet } from "./s/[serverId]/ownership/route";
import { GET as notificationsPage } from "./s/[serverId]/notifications/route";
import { GET as book } from "./s/[serverId]/book/[id]/route";

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

let n = 0;
async function world() {
  const admin = await makeAccount(db, `admin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `member${++n}`);
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "The Film", year: 2001, runtimeSeconds: 5400, imdbId: "tt0000001" });
  const { show, season, episodes: eps } = await makeShow(db, shows.id, 2, { name: "The Show" });
  await signIn(member);
  return { admin, server, member, movies, shows, film, show, season, eps };
}
const sid = (w: { server: { id: string } }) => ({ serverId: w.server.id });
const filmPage = async (w: Awaited<ReturnType<typeof world>>) => text(await title(req("/x"), ctx({ ...sid(w), id: w.film.id })));
const claim = (w: Awaited<ReturnType<typeof world>>, fields: Record<string, string>) =>
  ownership(post(`/tv/s/${w.server.id}/ownership`, { titleId: w.film.id, seasonId: "", back: `/tv/s/${w.server.id}/title/${w.film.id}`, ...fields }), ctx(sid(w)));

describe("who owns it, on a TV", () => {
  it("shows nothing while the server doesn't track ownership, and refuses to change anything", async () => {
    const w = await world();
    expect(await filmPage(w)).not.toContain("Who owns it");
    expect((await claim(w, { action: "claim" })).status).toBe(404);
  });

  it("lets a member claim (reviewed, then waiting), and tells the admin", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    const page = await filmPage(w);
    expect(page).toContain("Who owns it");
    expect(page).toContain("Nobody has claimed this yet");
    expect(page).toContain("I own a copy");
    const res = await claim(w, { action: "claim" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/title/${w.film.id}`);
    const after = await filmPage(w);
    expect(after).toContain("waiting for the admin");
    expect(after).not.toContain("I own a copy");
    const admin = await db.select().from(notifications);
    expect(admin.some((x) => x.accountId === w.admin.accountId && x.kind === "claim_waiting")).toBe(true);
  });

  it("settles at once on an instant server; then withdraw, share again, and give up", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    await claim(w, { action: "claim" });
    expect(await filmPage(w)).toContain("Withdraw my copy");
    await claim(w, { action: "withdraw" });
    const withdrawn = await filmPage(w);
    expect(withdrawn).toContain("Share my copy again");
    expect(withdrawn).toContain("You (withdrawn)");
    expect(withdrawn).not.toContain("can&#39;t be played right now"); // the owner can still play their own copy
    const other = await makeAccount(db, `other${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    await signIn(other);
    expect(await filmPage(w)).toContain("can&#39;t be played right now"); // everyone else can't, while the only copy is withdrawn
    await signIn(w.member);
    await claim(w, { action: "share" });
    expect(await filmPage(w)).toContain("Withdraw my copy");
    await claim(w, { action: "giveup" });
    expect(await filmPage(w)).toContain("Nobody has claimed this yet");
  });

  it("keeps a child's profile out of it, and ignores a bad request, a stranger's server and other sites", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    const [kid] = await db.insert(viewers).values({ accountId: w.member.accountId, name: "Kid", role: "limited", sortOrder: 5 }).returning();
    await signIn(w.member, kid);
    expect(await filmPage(w)).not.toContain("I own a copy");
    expect((await claim(w, { action: "claim" })).status).toBe(403);
    await signIn(w.member);
    expect((await claim(w, { action: "nonsense" })).status).toBe(404);
    expect((await claim(w, { action: "claim", titleId: "not-a-uuid" })).status).toBe(404);
    expect((await claim(w, { action: "claim", seasonId: w.season.id })).status).toBe(404); // a movie has no season
    const other = await world();
    await signIn(w.member);
    expect((await claim(w, { action: "claim", titleId: other.film.id })).status).toBe(404);
    const crossSite = new Request(`https://roam.example/tv/s/${w.server.id}/ownership`, { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ action: "claim", titleId: w.film.id }) });
    expect((await ownership(crossSite, ctx(sid(w)))).status).toBe(404);
    expect((await ownershipGet(req("/x"), ctx(sid(w)))).headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}`);
    expect(await filmPage(w)).toContain("I own a copy"); // nothing above changed anything
  });

  it("owns a show a season at a time", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    const page = await text(await show(req("/x"), ctx({ ...sid(w), id: w.show.id })));
    expect(page).toContain("Who owns season 1");
    const fields = { titleId: w.show.id, seasonId: w.season.id, back: `/tv/s/${w.server.id}/show/${w.show.id}`, action: "claim" };
    expect((await ownership(post("/x", { ...fields, seasonId: "" }), ctx(sid(w)))).status).toBe(404); // a show needs its season
    expect((await ownership(post("/x", fields), ctx(sid(w)))).status).toBe(303);
    expect(await text(await show(req("/x"), ctx({ ...sid(w), id: w.show.id })))).toContain("Withdraw my copy");
  });

  it("shows an audiobook's owners too", async () => {
    const w = await world();
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const b = await makeTitle(db, books.id, { kind: "audiobook", name: "A Book" });
    await saveSettings(db, w.server.id, { enabled: true });
    expect(await text(await book(req("/x"), ctx({ ...sid(w), id: b.id })))).toContain("Who owns it");
  });
});

describe("more on a movie's page", () => {
  it("lists chapters that open the movie at that moment", async () => {
    const w = await world();
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: w.film.id, partIndex: 0, boxFileId: `ch${++n}`, filename: "f.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 5400, chapters: [{ title: "Opening", startSeconds: 0 }, { title: "The Road", startSeconds: 1500 }, { title: "Finale", startSeconds: 4800 }] });
    const page = await filmPage(w);
    expect(page).toContain("Chapters");
    expect(page).toContain("The Road");
    expect(page).toContain("25:00");
    expect(page).toContain(`/tv/s/${w.server.id}/watch/title/${w.film.id}?t=1500`);
  });

  it("shows the parental guide from the film's content cues, marking what this profile skips", async () => {
    const w = await world();
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: w.film.id, partIndex: 0, boxFileId: `cu${++n}`, filename: "f.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 5400, contentCues: [{ startSeconds: 100, endSeconds: 130, category: "violence", severity: "high", channel: "both" }] });
    await db.update(viewers).set({ contentFilter: { violence: "medium" } }).where(eq(viewers.accountId, w.member.accountId));
    await signIn(w.member);
    const page = await filmPage(w);
    expect(page).toContain("Parental guide");
    expect(page).toContain("Violence · Strong");
    expect(page).toContain("1 scene · 30 sec");
    expect(page).toContain("skipped for you");
  });

  it("lists trailers and other extras, which play with no place kept", async () => {
    const w = await world();
    const [extra] = await db.insert(titleExtras).values({ titleId: w.film.id, name: "Teaser", category: "trailers", boxFileId: `ex${++n}` } as never).returning();
    await db.insert(mediaFiles).values({ ownerKind: "extra", ownerId: extra.id, partIndex: 0, boxFileId: `exf${n}`, filename: "t.mp4", sizeBytes: 1, container: "mp4", probeStatus: "ok", durationSeconds: 90, videoCodec: "avc1", audioCodec: "mp4a" });
    const page = await filmPage(w);
    expect(page).toContain("Trailers");
    expect(page).toContain(`/tv/s/${w.server.id}/watch/extra/${extra.id}`);
    const watchPageHtml = await text(await watch(req("/x"), ctx({ ...sid(w), kind: "extra", id: extra.id })));
    expect(watchPageHtml).toContain('"ownerKind":"extra"');
    expect(watchPageHtml).toContain(`/tv/s/${w.server.id}/title/${w.film.id}`);
    const other = await world();
    await signIn(w.member);
    expect((await watch(req("/x"), ctx({ ...sid(other), kind: "extra", id: extra.id }))).status).toBe(404);
  });

  it("starts at a chosen moment, and ignores a nonsense one", async () => {
    const w = await world();
    const at = async (q: string) => text(await watch(req(`/x${q}`), ctx({ ...sid(w), kind: "title", id: w.film.id })));
    expect(await at("?t=1500")).toContain('"start":1500');
    for (const bad of ["?t=-5", "?t=abc", "?t=999999", ""]) expect(await at(bad)).not.toContain('"start"');
  });
});

describe("notifications on a TV", () => {
  it("shows a button with the count, lists them with links, and marks them read", async () => {
    const w = await world();
    await db.insert(notifications).values([
      { accountId: w.member.accountId, serverId: w.server.id, kind: "available", titleId: w.film.id, message: "“The Film” is free to watch now.", href: "/s/x" },
      { accountId: w.member.accountId, serverId: w.server.id, kind: "claim_approved", titleId: w.show.id, message: "You now own “The Show”, season 1." },
    ]);
    expect(await text(await home(req("/x"), ctx(sid(w))))).toContain("Notifications (2)");
    const page = await text(await notificationsPage(req("/x"), ctx(sid(w))));
    expect(page).toContain("free to watch now");
    expect(page).toContain("· new");
    expect(page).toContain(`/tv/s/${w.server.id}/title/${w.film.id}`);
    expect(page).toContain(`/tv/s/${w.server.id}/show/${w.show.id}`);
    expect(await text(await home(req("/x"), ctx(sid(w))))).not.toContain("Notifications (");
    const again = await text(await notificationsPage(req("/x"), ctx(sid(w))));
    expect(again).toContain("free to watch now"); // still listed, now read
    expect(again).not.toContain("· new");
  });
  it("never shows someone else's, and says when there are none", async () => {
    const w = await world();
    await db.insert(notifications).values({ accountId: w.admin.accountId, serverId: w.server.id, kind: "claim_waiting", message: "A claim is waiting for review." });
    expect(await text(await notificationsPage(req("/x"), ctx(sid(w))))).toContain("Nothing new.");
    h.resolution = null;
    expect((await notificationsPage(req("/x"), ctx(sid(w)))).status).toBe(302);
  });
});
