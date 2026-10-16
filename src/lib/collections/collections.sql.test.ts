/** Film-series collections made from TMDB, hand-made ones, and who sees what. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { collectionItems, collections, libraryMembers, titles, tmdbEntries } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, refreshed: [] as number[], refreshResult: "refreshed" as string }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
// The shared-entry reader and refresher talk to TMDB: the tests stand in for them.
vi.mock("@/lib/tmdb/cache", () => ({
  getMovieDetails: async (id: number) => {
    const { db } = h.testDb;
    const [row] = await db.select().from(tmdbEntries).where(eq(tmdbEntries.tmdbId, id));
    return row.payload;
  },
  refreshEntry: async (_k: string, id: number) => {
    h.refreshed.push(id);
    return h.refreshResult;
  },
}));

import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";
import { backfillCollections, syncSeriesCollections } from "./sync";
import { collectionsOfTitle, getCollection, listCollections } from "./queries";
import { addToCollection, cleanName, createCollection, deleteCollection, removeFromCollection, renameCollection } from "./service";


autoFiles();
let db: TestDb;
beforeAll(async () => {
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.refreshed = [];
  h.refreshResult = "refreshed";
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "movies", access);
  const actor: LibraryActor = { serverId: server.id, accountId: member.accountId, isAdmin: false };
  const film = (name: string, over: Partial<typeof titles.$inferInsert> = {}) => makeTitle(db, lib.id, { kind: "movie", name, ...over });
  const series = (name: string, year: number, extra: Partial<typeof titles.$inferInsert> = {}) =>
    film(name, { year, collectionTmdbId: 100, collectionName: "Alien Collection", collectionPosterUrl: "https://img/alien.jpg", ...extra });
  return { admin, server, member, lib, actor, film, series };
}

describe("film series", () => {
  it("become collections of the movies that name them, once at least two are in the library", async () => {
    const w = await world();
    await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    await w.film("Solo film", { collectionTmdbId: 200, collectionName: "Lonely Collection" });
    await w.film("Not in one");
    await syncSeriesCollections(db, w.lib.id);
    const cards = await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id });
    expect(cards).toEqual([{ id: expect.any(String), name: "Alien Collection", kind: "tmdb", count: 2, posterUrl: "https://img/alien.jpg" }]);
    // Syncing again changes nothing.
    await syncSeriesCollections(db, w.lib.id);
    expect(await db.select().from(collections).where(eq(collections.libraryId, w.lib.id))).toHaveLength(2);
  });

  it("lists its films oldest first", async () => {
    const w = await world();
    await w.series("Alien 3", 1992);
    await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    const [card] = await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id });
    const detail = await getCollection(db, { actor: w.actor, viewer: adult, collectionId: card.id });
    expect(detail?.items.map((i) => i.name)).toEqual(["Alien", "Aliens", "Alien 3"]);
    expect(detail?.libraryName).toBe(w.lib.name);
  });

  it("lose a film that leaves the series or the library, and vanish when none are left", async () => {
    const w = await world();
    const a = await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    await db.update(titles).set({ collectionTmdbId: null, collectionName: null }).where(eq(titles.id, a.id)); // rematched to something else
    await syncSeriesCollections(db, w.lib.id);
    expect(await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id })).toEqual([]); // one film left: no tile
    await db.delete(titles).where(eq(titles.libraryId, w.lib.id));
    await syncSeriesCollections(db, w.lib.id);
    expect(await db.select().from(collections).where(eq(collections.libraryId, w.lib.id))).toEqual([]);
  });

  it("show only the films a profile's age limit allows, and none at all when fewer than two remain", async () => {
    const w = await world();
    await w.series("Kid one", 1990, { ratingAges: { US: 0 } });
    await w.series("Kid two", 1995, { ratingAges: { US: 6 } });
    await w.series("Grown-up", 2000, { ratingAges: { US: 17 } });
    await syncSeriesCollections(db, w.lib.id);
    const [adultCard] = await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id });
    expect(adultCard.count).toBe(3);
    const [kidCard] = await listCollections(db, { actor: w.actor, viewer: kid, libraryId: w.lib.id });
    expect(kidCard.count).toBe(2);
    const detail = await getCollection(db, { actor: w.actor, viewer: kid, collectionId: kidCard.id });
    expect(detail?.items.map((i) => i.name)).toEqual(["Kid one", "Kid two"]);
    await db.update(titles).set({ ratingAges: { US: 12 } }).where(eq(titles.name, "Kid two"));
    expect(await listCollections(db, { actor: w.actor, viewer: kid, libraryId: w.lib.id })).toEqual([]);
  });

  it("are not visible in a library the profile can't see, or from another server", async () => {
    const w = await world("restricted");
    await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    expect(await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id })).toEqual([]);
    const [c] = await db.select().from(collections).where(eq(collections.libraryId, w.lib.id));
    expect(await getCollection(db, { actor: w.actor, viewer: adult, collectionId: c.id })).toBeNull();
    await db.insert(libraryMembers).values({ libraryId: w.lib.id, serverId: w.server.id, accountId: w.member.accountId });
    expect(await getCollection(db, { actor: w.actor, viewer: adult, collectionId: c.id })).not.toBeNull();
    const other = await world();
    expect(await getCollection(db, { actor: other.actor, viewer: adult, collectionId: c.id })).toBeNull();
  });

  it("tell a title which collections it is in", async () => {
    const w = await world();
    const a = await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    const lone = await w.film("Lone");
    await syncSeriesCollections(db, w.lib.id);
    expect((await collectionsOfTitle(db, { actor: w.actor, viewer: adult, titleId: a.id })).map((c) => c.name)).toEqual(["Alien Collection"]);
    expect(await collectionsOfTitle(db, { actor: w.actor, viewer: adult, titleId: lone.id })).toEqual([]);
  });
});

describe("finding out which series a movie is in", () => {
  it("reads it from an entry that already has the answer, with no call to TMDB", async () => {
    const w = await world();
    const t = await w.film("Alien", { tmdbId: 348, metadataStatus: "matched" });
    await db.insert(tmdbEntries).values({ kind: "movie", tmdbId: 348, season: 0, payload: { id: 348, title: "Alien", belongs_to_collection: { id: 8091, name: "Alien Collection", poster_path: "/a.jpg" } } });
    expect(await backfillCollections(db, w.lib.id, Date.now() + 5000)).toBe(false);
    const [after] = await db.select().from(titles).where(eq(titles.id, t.id));
    expect(after).toMatchObject({ collectionTmdbId: 8091, collectionName: "Alien Collection", collectionPosterUrl: "https://image.tmdb.org/t/p/w342/a.jpg" });
    expect(after.collectionAttemptedAt).not.toBeNull();
    expect(h.refreshed).toEqual([]);
  });

  it("notes a movie that is in none, and asks TMDB again for an entry stored before collections were read", async () => {
    const w = await world();
    const none = await w.film("Standalone", { tmdbId: 1, metadataStatus: "matched" });
    await db.insert(tmdbEntries).values({ kind: "movie", tmdbId: 1, season: 0, payload: { id: 1, belongs_to_collection: null } });
    const old = await w.film("Old entry", { tmdbId: 2, metadataStatus: "matched" });
    await db.insert(tmdbEntries).values({ kind: "movie", tmdbId: 2, season: 0, payload: { id: 2, title: "Old entry" } });
    await backfillCollections(db, w.lib.id, Date.now() + 5000);
    expect(h.refreshed).toEqual([2]);
    const [a] = await db.select().from(titles).where(eq(titles.id, none.id));
    expect(a.collectionTmdbId).toBeNull();
    expect(a.collectionAttemptedAt).not.toBeNull();
    // The refresh is mocked, so nothing was written for the old entry, but it was not left asking forever on a failure:
    h.refreshResult = "failed";
    h.refreshed = [];
    await db.update(titles).set({ collectionAttemptedAt: null }).where(eq(titles.id, old.id));
    await backfillCollections(db, w.lib.id, Date.now() + 5000);
    const [b] = await db.select().from(titles).where(eq(titles.id, old.id));
    expect(b.collectionAttemptedAt).not.toBeNull();
  });

  it("leaves unmatched movies and shows alone, and stops at the deadline", async () => {
    const w = await world();
    const pending = await w.film("Unmatched", { tmdbId: 5, metadataStatus: "pending" });
    await w.film("Matched", { tmdbId: 6, metadataStatus: "matched" });
    await backfillCollections(db, w.lib.id, Date.now() - 1); // out of time before the first
    const [p] = await db.select().from(titles).where(eq(titles.id, pending.id));
    expect(p.collectionAttemptedAt).toBeNull();
    expect(h.refreshed).toEqual([]);
  });
});

describe("hand-made collections", () => {
  it("are made, filled in order, renamed and emptied", async () => {
    const w = await world();
    const [a, b, c] = [await w.film("A", { year: 2003 }), await w.film("B", { year: 2001 }), await w.film("C", { year: 2002 })];
    const made = await createCollection(db, { libraryId: w.lib.id, name: "Friday night" });
    if (made === "taken") throw new Error("unexpected");
    expect(await createCollection(db, { libraryId: w.lib.id, name: "friday NIGHT" })).toBe("taken");
    expect(await addToCollection(db, made.id, [c.id, a.id])).toBe(2);
    expect(await addToCollection(db, made.id, [a.id, b.id])).toBe(1); // A is already there
    let detail = await getCollection(db, { actor: w.actor, viewer: adult, collectionId: made.id });
    expect(detail?.items.map((i) => i.name)).toEqual(["C", "A", "B"]); // the order they were put in, not by year
    expect(await renameCollection(db, made.id, "Saturday")).toBe("ok");
    expect(await removeFromCollection(db, made.id, a.id)).toBe(true);
    detail = await getCollection(db, { actor: w.actor, viewer: adult, collectionId: made.id });
    expect(detail?.name).toBe("Saturday");
    expect(detail?.items.map((i) => i.name)).toEqual(["C", "B"]);
    // A one-title hand-made collection still shows (a series needs two).
    await removeFromCollection(db, made.id, c.id);
    expect((await listCollections(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id })).map((x) => [x.name, x.count])).toEqual([["Saturday", 1]]);
    expect(await deleteCollection(db, made.id)).toBe(true);
    expect(await db.select().from(collectionItems)).toEqual(expect.not.arrayContaining([expect.objectContaining({ collectionId: made.id })]));
    expect(await db.select().from(titles).where(eq(titles.id, a.id))).toHaveLength(1); // the titles themselves are untouched
  });

  it("only take titles from their own library, and leave film series alone", async () => {
    const w = await world();
    const elsewhere = await makeLibrary(db, w.server.id, "movies");
    const foreign = await makeTitle(db, elsewhere.id, { kind: "movie", name: "Elsewhere" });
    const photo = await w.film("A photo", { kind: "photo" });
    const made = await createCollection(db, { libraryId: w.lib.id, name: "Mine" });
    if (made === "taken") throw new Error("unexpected");
    expect(await addToCollection(db, made.id, [foreign.id, photo.id])).toBe(0);
    await w.series("Alien", 1979);
    await w.series("Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    const [series] = await db.select().from(collections).where(eq(collections.kind, "tmdb"));
    expect(await renameCollection(db, series.id, "Mine now")).toBe("not_found");
    expect(await deleteCollection(db, series.id)).toBe(false);
    expect(await addToCollection(db, series.id, [(await w.film("X")).id])).toBeNull();
    expect(await removeFromCollection(db, series.id, (await db.select().from(collectionItems))[0].titleId)).toBe(false);
  });

  it("have clean names", () => {
    expect(cleanName("  Friday   night ")).toBe("Friday night");
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(5)).toBeNull();
    expect(cleanName("x".repeat(81))).toBeNull();
  });
});

afterAll(() => undefined);
