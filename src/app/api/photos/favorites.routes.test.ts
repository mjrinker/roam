/** Favorites: per profile, gated like every photo route, idempotent, and bound to what the viewer may still see. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  limited: false,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => !h.limited }));

import { photoFavorites, profiles, titles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, makeViewer, type TestDb } from "@/lib/playlists/test-db";
import { listTimeline } from "@/lib/photos/timeline";
import { DELETE, PUT } from "./[id]/favorite/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(async () => {
  h.limited = false;
  await db.delete(photoFavorites); // the database is shared by every test in this file
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const put = (id: string) => PUT(new Request("http://x", { method: "PUT" }), ctx(id));
const del = (id: string) => DELETE(new Request("http://x", { method: "DELETE" }), ctx(id));
async function signInAs(accountId: string, viewerId?: string, over: Partial<typeof viewers.$inferSelect> = {}) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  const viewer = all.find((v) => v.id === (viewerId ?? accountId))!;
  h.resolution = { account, viewer: { ...viewer, ...over }, viewers: all };
}
const rows = () => db.select().from(photoFavorites);
let n = 0;

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "m");
  await joinServer(db, server.id, member.accountId);
  const second = await makeViewer(db, member.accountId, { role: "limited" });
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const secret = await makeLibrary(db, server.id, "photos", "restricted");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const mk = (libraryId: string, kind: "photo" | "movie", over = {}) => makeTitle(db, libraryId, { kind, boxFolderId: `file:fv${++n}`, takenAt: new Date(Date.UTC(2024, 0, 1 + n)), takenAtSource: "box", ...over });
  const photo = await mk(photos.id, "photo");
  const clip = await mk(photos.id, "movie");
  const hidden = await mk(secret.id, "photo");
  const film = await makeTitle(db, movies.id, { kind: "movie", boxFolderId: `f${++n}` });
  await signInAs(member.accountId);
  return { owner, server, member, second, photos, secret, photo, clip, hidden, film, mk };
}

describe("hearting", () => {
  it("hearts and un-hearts a picture or a video, idempotently, for the profile asking", async () => {
    const w = await world();
    for (const id of [w.photo.id, w.clip.id]) {
      expect((await (await put(id)).json())).toEqual({ favorite: true });
      expect((await put(id)).status).toBe(200); // again: no error, no duplicate
    }
    expect((await rows()).filter((r) => r.viewerId === w.member.accountId)).toHaveLength(2);
    expect((await (await del(w.photo.id)).json())).toEqual({ favorite: false });
    expect((await del(w.photo.id)).status).toBe(200); // un-hearting twice is fine
    expect((await rows()).map((r) => r.titleId)).toEqual([w.clip.id]);
  });

  it("is the same 404 for a bad id, a missing title, a hidden library, an ordinary movie and a signed-out visitor, and writes nothing", async () => {
    const w = await world();
    const seen = new Set<string>();
    for (const id of ["nope", "00000000-0000-4000-8000-0000000000e1", w.hidden.id, w.film.id]) {
      for (const fn of [put, del]) {
        const r = await fn(id);
        seen.add(`${r.status} ${JSON.stringify(await r.json())}`);
      }
    }
    expect([...seen]).toEqual([`404 ${JSON.stringify({ error: "Not found" })}`]);
    h.resolution = null;
    expect((await put(w.photo.id)).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it("an age-blocked title can't be hearted", async () => {
    const w = await world();
    await db.update(titles).set({ ratingAges: { ANY: 18 } as never }).where(eq(titles.id, w.photo.id));
    await signInAs(w.member.accountId, undefined, { maxAge: 12, allowUnrated: false } as never);
    expect((await put(w.photo.id)).status).toBe(404);
  });

  it("is rate limited with an uncached 429, separately from the image routes", async () => {
    const w = await world();
    h.limited = true;
    const r = await put(w.photo.id);
    expect([r.status, r.headers.get("cache-control"), r.headers.get("retry-after")]).toEqual([429, "no-store", "10"]);
    expect(await rows()).toEqual([]);
  });
});

describe("per profile", () => {
  it("each profile keeps its own hearts: a second profile on the same account sees none of the first's", async () => {
    const w = await world();
    await put(w.photo.id);
    const everyone = { locale: "en-US", maxAge: null, allowUnrated: true } as const;
    const actor = { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false };
    const list = (viewerId: string, favoritesOnly = true) => listTimeline(db, { actor, viewer: everyone, viewerId, libraryId: w.photos.id, favoritesOnly });
    expect((await list(w.member.accountId))!.items.map((i) => i.id)).toEqual([w.photo.id]);
    expect((await list(w.second.id))!.items).toEqual([]);
    // and the heart flag on the ordinary timeline follows the profile
    const flags = async (viewerId: string) => Object.fromEntries((await list(viewerId, false))!.items.map((i) => [i.id, i.favorite]));
    expect(await flags(w.member.accountId)).toEqual({ [w.photo.id]: true, [w.clip.id]: false });
    expect(await flags(w.second.id)).toEqual({ [w.photo.id]: false, [w.clip.id]: false });
    // a second profile can heart the same photo without touching the first's
    await signInAs(w.member.accountId, w.second.id);
    await put(w.photo.id);
    expect(await rows()).toHaveLength(2);
    await del(w.photo.id);
    expect((await rows()).map((r) => r.viewerId)).toEqual([w.member.accountId]);
  });

  it("a favorite that later becomes hidden or age-blocked stops showing, and comes back if access does", async () => {
    const w = await world();
    await put(w.photo.id);
    await put(w.clip.id);
    const actor = { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false };
    const ids = async (viewer: { locale: string; maxAge: number | null; allowUnrated: boolean }) =>
      (await listTimeline(db, { actor, viewer, viewerId: w.member.accountId, libraryId: w.photos.id, favoritesOnly: true }))!.items.map((i) => i.id).sort();
    const open = { locale: "en-US", maxAge: null, allowUnrated: true };
    expect(await ids(open)).toEqual([w.photo.id, w.clip.id].sort());
    await db.update(titles).set({ ratingAges: { ANY: 8 } as never }).where(eq(titles.id, w.photo.id));
    await db.update(titles).set({ ratingAges: { ANY: 18 } as never }).where(eq(titles.id, w.clip.id));
    expect(await ids({ locale: "en-US", maxAge: 12, allowUnrated: false })).toEqual([w.photo.id]);
    expect(await ids(open)).toEqual([w.photo.id, w.clip.id].sort());
  });

  it("a restricted library's favorites vanish when the account loses access to it", async () => {
    const w = await world();
    const { libraryMembers } = await import("@/lib/db/schema");
    await db.insert(libraryMembers).values({ libraryId: w.secret.id, accountId: w.member.accountId, serverId: w.server.id });
    expect((await put(w.hidden.id)).status).toBe(200);
    await db.delete(libraryMembers).where(eq(libraryMembers.libraryId, w.secret.id));
    const actor = { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false };
    expect(await listTimeline(db, { actor, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.member.accountId, libraryId: w.secret.id, favoritesOnly: true })).toBeNull();
  });
});

describe("storage", () => {
  it("favorites go away with their title or their profile", async () => {
    const w = await world();
    const extra = await w.mk(w.photos.id, "photo");
    await put(w.photo.id);
    await put(extra.id);
    await db.delete(titles).where(eq(titles.id, extra.id));
    expect((await rows()).map((r) => r.titleId)).toEqual([w.photo.id]);
    await db.delete(viewers).where(eq(viewers.id, w.member.accountId));
    expect(await rows()).toEqual([]);
  });

  it("the table is not open to the public API (row level security is on)", async () => {
    await world();
    const res = await db.execute(sql`select relrowsecurity from pg_class where relname = 'photo_favorites'`);
    expect((res.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
  });
});
