/** Video library ratings: the choices, the atomic rewrite of every title, and the admin-only endpoints. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  admin: null as unknown,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => h.admin }));

import { libraries, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { PUT as putRating } from "@/app/api/libraries/[id]/rating/route";
import { POST as createLibrary } from "@/app/api/libraries/route";
import * as ratingModule from "./video-rating";
import { agesToRating, isVideoRating, ratingToAges, setVideoLibraryRating, VIDEO_RATING_OPTIONS } from "./video-rating";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.admin = null;
});

describe("rating helpers", () => {
  it("stores a rating as the catch-all ANY age, and null as unrated", () => {
    expect(ratingToAges(0)).toEqual({ ANY: 0 });
    expect(ratingToAges(18)).toEqual({ ANY: 18 });
    expect(ratingToAges(null)).toBeNull();
    expect(agesToRating({ ANY: 13 })).toBe(13);
    expect(agesToRating(null)).toBeNull();
    expect(agesToRating({ US: 12 })).toBeNull();
  });

  it("accepts only the offered ratings", () => {
    for (const o of VIDEO_RATING_OPTIONS) expect(isVideoRating(o.value)).toBe(true);
    for (const bad of [-1, 5, 19, 7.5, "7", undefined, NaN, Infinity]) expect(isVideoRating(bad), String(bad)).toBe(false);
  });
});

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const video = await makeLibrary(db, server.id, "video", "everyone");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const a = await makeTitle(db, video.id, { boxFolderId: `file:${Math.random()}`, ratingAges: { ANY: 0 } });
  const b = await makeTitle(db, video.id, { boxFolderId: `file:${Math.random()}`, ratingAges: { ANY: 0 } });
  const other = await makeTitle(db, movies.id, { ratingAges: { US: 12 } });
  return { server, video, movies, a, b, other };
}

describe("setVideoLibraryRating", () => {
  it("rewrites the library and every title in it, and nothing else", async () => {
    const w = await world();
    expect(await setVideoLibraryRating(db, w.video.id, 18)).toEqual({ ok: true });
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, w.video.id));
    expect(lib.ratingAges).toEqual({ ANY: 18 });
    const rows = await db.select().from(titles).where(eq(titles.libraryId, w.video.id));
    expect(rows.map((t) => t.ratingAges)).toEqual([{ ANY: 18 }, { ANY: 18 }]);
    const [other] = await db.select().from(titles).where(eq(titles.id, w.other.id));
    expect(other.ratingAges).toEqual({ US: 12 });

    expect(await setVideoLibraryRating(db, w.video.id, null)).toEqual({ ok: true });
    expect((await db.select().from(titles).where(eq(titles.libraryId, w.video.id))).map((t) => t.ratingAges)).toEqual([null, null]);
  });

  it("refuses libraries that aren't video libraries, and unknown ones", async () => {
    const w = await world();
    expect(await setVideoLibraryRating(db, w.movies.id, 7)).toEqual({ ok: false, reason: "unsupported_kind" });
    expect(await setVideoLibraryRating(db, "00000000-0000-4000-8000-0000000000aa", 7)).toEqual({ ok: false, reason: "not_found" });
    const [other] = await db.select().from(titles).where(eq(titles.id, w.other.id));
    expect(other.ratingAges).toEqual({ US: 12 });
  });
  // The race with a scan writing titles at the same moment relies on row locks (this FOR UPDATE vs the
  // scan's FOR SHARE), which a single-session in-memory database can't interleave; it is covered by
  // the locking protocol itself and exercised for real only against Postgres.
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const put = (id: string, body: unknown) =>
  putRating(new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));

describe("PUT /api/libraries/[id]/rating", () => {
  it("answers the same 404 to everyone who isn't a server admin, and to bad or unknown ids", async () => {
    const w = await world();
    h.admin = null;
    const denied = await put(w.video.id, { rating: 7 });
    const unknown = await put("00000000-0000-4000-8000-0000000000bb", { rating: 7 });
    const malformed = await put("not-a-uuid", { rating: 7 });
    for (const r of [denied, unknown, malformed]) expect(r.status).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, w.video.id));
    expect(lib.ratingAges).toBeNull(); // untouched
  });

  it("lets the admin rate a video library, validates the value, and refuses other kinds", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    expect((await put(w.video.id, { rating: 13 })).status).toBe(200);
    expect((await db.select().from(libraries).where(eq(libraries.id, w.video.id)))[0].ratingAges).toEqual({ ANY: 13 });
    expect((await put(w.video.id, { rating: null })).status).toBe(200);
    for (const bad of [{ rating: 9 }, { rating: "7" }, {}, null]) expect((await put(w.video.id, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await put(w.movies.id, { rating: 7 })).status).toBe(400);
  });
});

describe("PUT /api/libraries/[id]/rating when the library is busy", () => {
  it("says to try again (409) instead of failing with a 500 when the lock times out, and changes nothing", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    const spy = vi.spyOn(ratingModule, "setVideoLibraryRating").mockRejectedValueOnce(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
    const res = await put(w.video.id, { rating: 13 });
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/busy/);
    expect((await db.select().from(libraries).where(eq(libraries.id, w.video.id)))[0].ratingAges).toBeNull();
    // An error that is not a lock timeout is still surfaced, not swallowed.
    const boom = vi.spyOn(ratingModule, "setVideoLibraryRating").mockRejectedValueOnce(new Error("disk on fire"));
    await expect(put(w.video.id, { rating: 13 })).rejects.toThrow("disk on fire");
    boom.mockRestore();
  });
});

describe("POST /api/libraries (video)", () => {
  const create = (body: unknown) =>
    createLibrary(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  it("requires a rating for a video library, stores it, and starts restricted", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    const base = { serverId: w.server.id, name: "Home Videos", kind: "video", boxFolderId: "box-home-videos" };
    expect((await create(base)).status).toBe(400); // no rating given
    expect((await create({ ...base, rating: 5 })).status).toBe(400); // not an offered rating
    const ok = await create({ ...base, rating: 0 });
    expect(ok.status).toBe(200);
    const { library } = await ok.json();
    expect(library).toMatchObject({ kind: "video", access: "restricted", ratingAges: { ANY: 0 } });

    const unrated = await create({ ...base, boxFolderId: "box-unrated", name: "Unrated", rating: null });
    expect((await unrated.json()).library.ratingAges).toBeNull();
  });

  it("creates an audio library the same way: rating required, restricted to start", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    const base = { serverId: w.server.id, name: "Podcasts", kind: "audio", boxFolderId: "box-podcasts" };
    expect((await create(base)).status).toBe(400); // no rating
    const ok = await create({ ...base, rating: 7 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).library).toMatchObject({ kind: "audio", access: "restricted", ratingAges: { ANY: 7 } });
  });

  it("has no limit on how many libraries a server can have (it used to stop at five)", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    for (let i = 0; i < 9; i++) {
      const res = await create({ serverId: w.server.id, name: `Library ${i}`, kind: "movies", boxFolderId: `box-many-${w.server.id}-${i}` });
      expect(res.status, `library ${i}`).toBe(200);
    }
    expect((await db.select().from(libraries).where(eq(libraries.serverId, w.server.id))).length).toBeGreaterThan(10);
  });

  it("rejects a rating on any other kind of library", async () => {
    const w = await world();
    h.admin = { profile: { id: "x" }, role: "admin" };
    const res = await create({ serverId: w.server.id, name: "Films", kind: "movies", boxFolderId: "box-films", rating: 7 });
    expect(res.status).toBe(400);
  });
});
