/** Mark as watched / listened to / read, through the route: what it writes, for whom, and what it refuses. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, viewers, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./mark/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const mark = (body: unknown, contentType = "application/json") => POST(new Request("http://x", { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const rows = (viewerId: string) => db.select().from(watchState).where(eq(watchState.viewerId, viewerId));
const stateOf = async (viewerId: string, ownerKind: "title" | "episode", ownerId: string) =>
  (await db.select().from(watchState).where(and(eq(watchState.viewerId, viewerId), eq(watchState.ownerKind, ownerKind), eq(watchState.ownerId, ownerId))))[0];

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = (kind: Parameters<typeof makeLibrary>[2]) => makeLibrary(db, server.id, kind, access);
  await signInAs(me.accountId);
  return { server, me, lib };
}

describe("marking a title", () => {
  it("marks a movie watched and then unwatched, for this profile only", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film", runtimeSeconds: 5400 });
    const other = await makeAccount(db, "other");
    await joinServer(db, w.server.id, other.accountId);
    const res = await mark({ kind: "title", id: film.id, done: true });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, count: 1 }]);
    expect(await stateOf(w.me.viewer.id, "title", film.id)).toMatchObject({ finished: true, positionSeconds: 5400, durationSeconds: 5400 });
    expect(await rows(other.viewer.id)).toEqual([]); // someone else's shelf is untouched
    expect((await mark({ kind: "title", id: film.id, done: false })).status).toBe(200);
    expect(await rows(w.me.viewer.id)).toEqual([]);
    expect((await mark({ kind: "title", id: film.id, done: false })).status).toBe(200); // undoing twice is harmless
  });
  it("finishes a half-watched title without losing its length, and does not break when marked twice", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    await db.insert(watchState).values({ viewerId: w.me.viewer.id, ownerKind: "title", ownerId: film.id, positionSeconds: 300, durationSeconds: 3000, finished: false });
    await mark({ kind: "title", id: film.id, done: true });
    await mark({ kind: "title", id: film.id, done: true });
    const all = await rows(w.me.viewer.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ finished: true, positionSeconds: 3000, durationSeconds: 3000 });
  });
  it("works for an audiobook, an audio file, a video-library clip and an eBook", async () => {
    const w = await world();
    const things = [
      await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "Book" }),
      await makeTitle(db, (await w.lib("audio")).id, { kind: "audiobook", name: "Talk" }),
      await makeTitle(db, (await w.lib("video")).id, { kind: "movie", name: "Clip" }),
      await makeTitle(db, (await w.lib("ebooks")).id, { kind: "ebook", name: "Epub" }),
    ];
    for (const t of things) expect((await mark({ kind: "title", id: t.id, done: true })).status, t.name).toBe(200);
    expect((await rows(w.me.viewer.id)).map((r) => r.finished)).toEqual([true, true, true, true]);
  });
  it("refuses what keeps no place (pictures, a clip beside them, songs), and a show as a title", async () => {
    const w = await world();
    const pic = await makeTitle(db, (await w.lib("photos")).id, { kind: "photo", name: "Pic", takenAt: new Date() });
    const clip = await makeTitle(db, (await w.lib("photos")).id, { kind: "movie", name: "Clip", takenAt: new Date() });
    const song = await makeTitle(db, (await w.lib("music")).id, { kind: "audiobook", name: "Song" });
    const { show } = await makeShow(db, (await w.lib("shows")).id, 1, { name: "Show" });
    for (const t of [pic, clip, song, show]) expect((await mark({ kind: "title", id: t.id, done: true })).status, t.name).toBe(404);
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
});

describe("marking episodes, seasons and shows", () => {
  async function twoSeasons() {
    const w = await world();
    const shows = await w.lib("shows");
    const { show, season: s1, episodes: e1 } = await makeShow(db, shows.id, 2, { name: "Show" });
    const [s2] = await db.insert((await import("@/lib/db/schema")).seasons).values({ titleId: show.id, number: 2, boxFolderId: `s2-${show.id}` }).returning();
    const [e3] = await db.insert((await import("@/lib/db/schema")).episodes).values({ seasonId: s2.id, number: 1, name: "S2E1" }).returning();
    return { w, show, s1, s2, e1, e3 };
  }
  it("marks one episode, one season, or the whole show, and undoes each", async () => {
    const { w, show, s1, e1, e3 } = await twoSeasons();
    await mark({ kind: "episode", id: e1[0].id, done: true });
    expect((await rows(w.me.viewer.id)).map((r) => r.ownerId)).toEqual([e1[0].id]);
    await mark({ kind: "season", id: s1.id, done: true });
    expect((await rows(w.me.viewer.id)).map((r) => r.ownerId).sort()).toEqual([e1[0].id, e1[1].id].sort());
    expect(await stateOf(w.me.viewer.id, "episode", e3.id)).toBeUndefined(); // the other season is untouched
    await mark({ kind: "show", id: show.id, done: true });
    expect(await rows(w.me.viewer.id)).toHaveLength(3);
    await mark({ kind: "season", id: s1.id, done: false });
    expect((await rows(w.me.viewer.id)).map((r) => r.ownerId)).toEqual([e3.id]);
    await mark({ kind: "show", id: show.id, done: false });
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
  it("marking a show again finishes episodes that were half-watched and leaves finished ones finished", async () => {
    const { w, show, e1 } = await twoSeasons();
    await db.insert(watchState).values({ viewerId: w.me.viewer.id, ownerKind: "episode", ownerId: e1[0].id, positionSeconds: 100, durationSeconds: 1000, finished: false });
    await mark({ kind: "show", id: show.id, done: true });
    await mark({ kind: "show", id: show.id, done: true });
    expect((await rows(w.me.viewer.id)).every((r) => r.finished)).toBe(true);
    expect(await stateOf(w.me.viewer.id, "episode", e1[0].id)).toMatchObject({ positionSeconds: 1000 });
  });
  it("refuses a missing season, an episode id used as a show, and bad input", async () => {
    const { w, e1 } = await twoSeasons();
    expect((await mark({ kind: "season", id: "00000000-0000-4000-8000-0000000000aa", done: true })).status).toBe(404);
    expect((await mark({ kind: "show", id: e1[0].id, done: true })).status).toBe(404);
    for (const bad of ["not json", { kind: "movie", id: e1[0].id, done: true }, { kind: "episode", id: "nope", done: true }, { kind: "episode", id: e1[0].id }]) expect((await mark(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
});

describe("unmarking and forged requests", () => {
  it("unmarking removes finished rows only: something half-watched keeps its place", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    await db.insert(watchState).values({ viewerId: w.me.viewer.id, ownerKind: "title", ownerId: film.id, positionSeconds: 300, durationSeconds: 3000, finished: false });
    expect((await mark({ kind: "title", id: film.id, done: false })).status).toBe(200);
    expect(await stateOf(w.me.viewer.id, "title", film.id)).toMatchObject({ positionSeconds: 300, finished: false });
    await mark({ kind: "title", id: film.id, done: true });
    await mark({ kind: "title", id: film.id, done: false });
    expect(await stateOf(w.me.viewer.id, "title", film.id)).toBeUndefined();
  });
  it("only accepts a JSON post, so another site's form can't send it", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    const body = JSON.stringify({ kind: "title", id: film.id, done: true });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) expect((await mark(body, type)).status, type).toBe(415);
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
  it("answers 404 for a season of a hidden show or another server", async () => {
    const w = await world();
    const hidden = await world("restricted");
    const { season: hiddenSeason } = await makeShow(db, (await hidden.lib("shows")).id, 1, { name: "Hidden" });
    const other = await world();
    const { season: otherSeason } = await makeShow(db, (await other.lib("shows")).id, 1, { name: "Other" });
    await signInAs(w.me.accountId);
    for (const s of [hiddenSeason, otherSeason]) expect((await mark({ kind: "season", id: s.id, done: true })).status).toBe(404);
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
});

describe("what a profile may not mark", () => {
  it("answers 404 for a hidden library, another server's title and anything the age limit forbids, and writes nothing", async () => {
    const w = await world();
    const hidden = await world("restricted");
    const secret = await makeTitle(db, (await hidden.lib("movies")).id, { kind: "movie", name: "Secret" });
    const other = await world();
    const theirs = await makeTitle(db, (await other.lib("movies")).id, { kind: "movie", name: "Theirs" });
    await signInAs(w.me.accountId);
    const adult = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Adult", ratingAges: { ANY: 17 } });
    const { show: adultShow, episodes: adultEps } = await makeShow(db, (await w.lib("shows")).id, 1, { name: "Adult show", ratingAges: { ANY: 17 } });
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.me.viewer.id));
    await signInAs(w.me.accountId);
    const attempts = [
      { kind: "title", id: secret.id }, // a server this account is not in: not even a member
      { kind: "title", id: theirs.id },
      { kind: "title", id: adult.id },
      { kind: "show", id: adultShow.id },
      { kind: "episode", id: adultEps[0].id },
    ];
    for (const a of attempts) expect((await mark({ ...a, done: true })).status, JSON.stringify(a)).toBe(404); // not a member looks the same as not found
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
  it("is refused when nobody is signed in", async () => {
    const w = await world();
    const film = await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Film" });
    h.resolution = null;
    expect((await mark({ kind: "title", id: film.id, done: true })).status).toBe(404);
    expect(await rows(w.me.viewer.id)).toEqual([]);
  });
});
