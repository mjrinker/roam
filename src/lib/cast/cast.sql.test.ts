/** The cast of a movie or show, fetched from TMDB, and a person's page: their titles on this server that the viewer may see. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, credits: new Map<number, unknown>(), crew: new Map<number, unknown[]>(), asked: [] as string[] }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/tmdb/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tmdb/client")>();
  return {
    ...original,
    getCredits: async (kind: string, id: number) => {
      h.asked.push(`${kind}:${id}`);
      const c = h.credits.get(id);
      if (c instanceof Error) throw c;
      const crew = h.crew.get(id) ?? [];
      return { cast: [...((c ?? []) as { order: number }[])].sort((a, b) => a.order - b.order), crew } as never; // sorted as the real call does
    },
  };
});

import { libraries, titleCast, titleCrew, titles } from "@/lib/db/schema";
import { keyCrew } from "@/lib/content/cast-backfill";
import { backfillCast, CAST_KEPT } from "@/lib/content/cast-backfill";
import { loadPersonPage, loadTitleCast, loadTitleCrew } from "./queries";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let tmdb = 1000;
async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const actor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const movie = async (name: string, over: Partial<typeof titles.$inferInsert> = {}, libraryId = lib.id) =>
    makeTitle(db, libraryId, { kind: "movie", name, tmdbId: ++tmdb, ratingAges: { ANY: 0 }, year: 2000, ...over });
  return { server, lib, me, actor, movie };
}
const person = (id: number, name: string, character: string | null = null, order = id) => ({ id, name, character, profile_path: `/p${id}.jpg`, order });
const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid = { locale: "en-US", maxAge: 7, allowUnrated: false };

describe("fetching the cast", () => {
  it("keeps the billed cast in order, with photos, and asks about each title once", async () => {
    const w = await world();
    const m = await w.movie("A Film");
    h.credits.set(m.tmdbId!, [person(3, "Third", "Z", 2), person(1, "First", "Hero", 0), person(2, "Second", "  ", 1), person(2, "Second again", "dup", 5)]);
    h.asked.length = 0;
    expect(await backfillCast(w.lib.id, Date.now() + 60_000)).toBe(false);
    expect((await loadTitleCast(db, m.id)).map((c) => [c.personId, c.name, c.character, c.photoUrl?.endsWith("/p" + c.personId + ".jpg")])).toEqual([
      [1, "First", "Hero", true],
      [2, "Second", null, true],
      [3, "Third", "Z", true],
    ]);
    await backfillCast(w.lib.id, Date.now() + 60_000);
    expect(h.asked).toEqual([`movie:${m.tmdbId}`]);
  });
  it("keeps only the top of a long cast, handles shows, and carries on past a title TMDB can't answer for", async () => {
    const w = await world();
    const big = await w.movie("Big Cast");
    const show = await makeTitle(db, w.lib.id, { kind: "show", name: "A Show", tmdbId: ++tmdb, ratingAges: { ANY: 0 } });
    const broken = await w.movie("Broken");
    const unmatched = await makeTitle(db, w.lib.id, { kind: "movie", name: "No Match", ratingAges: { ANY: 0 } });
    h.credits.set(big.tmdbId!, Array.from({ length: 60 }, (_, i) => person(5000 + i, `P${i}`, null, i)));
    h.credits.set(show.tmdbId!, [person(9000, "Lead")]);
    h.credits.set(broken.tmdbId!, new Error("TMDB down"));
    h.asked.length = 0;
    await backfillCast(w.lib.id, Date.now() + 60_000);
    expect(await loadTitleCast(db, big.id)).toHaveLength(CAST_KEPT);
    expect((await loadTitleCast(db, big.id))[0].name).toBe("P0");
    expect((await loadTitleCast(db, show.id)).map((c) => c.name)).toEqual(["Lead"]);
    expect(h.asked).toContain(`show:${show.tmdbId}`);
    expect(await loadTitleCast(db, broken.id)).toEqual([]);
    expect(h.asked.some((a) => a.endsWith(`:${unmatched.tmdbId}`))).toBe(false); // no TMDB match, nothing to ask
    const [stamped] = await db.select({ at: titles.castAttemptedAt }).from(titles).where(eq(titles.id, broken.id));
    expect(stamped.at).not.toBeNull(); // not asked again every scan
  });
  it("asks again for one title when that is requested, replacing what was there", async () => {
    const w = await world();
    const m = await w.movie("Redo");
    h.credits.set(m.tmdbId!, [person(1, "Old")]);
    await backfillCast(w.lib.id, Date.now() + 60_000);
    h.credits.set(m.tmdbId!, [person(2, "New")]);
    await db.update(titles).set({ castAttemptedAt: null }).where(eq(titles.id, m.id));
    await backfillCast(w.lib.id, Date.now() + 60_000, m.id);
    expect((await loadTitleCast(db, m.id)).map((c) => c.name)).toEqual(["New"]);
  });
});

describe("a person's page", () => {
  async function cast(titleId: string, ...people: [number, string, string | null][]) {
    await db.insert(titleCast).values(people.map(([personId, name, character], position) => ({ titleId, personId, name, character, photoUrl: null, position })));
  }
  it("lists their movies and shows on this server, newest first, with their roles", async () => {
    const w = await world();
    const a = await w.movie("Older", { year: 1999 });
    const b = await w.movie("Newer", { year: 2015 });
    const s = await makeTitle(db, w.lib.id, { kind: "show", name: "Series", year: 2008, ratingAges: { ANY: 0 } });
    const other = await w.movie("Without Them");
    await cast(a.id, [77, "Pat Actor", "Young Pat"]);
    await cast(b.id, [77, "Pat Actor", "Old Pat"], [78, "Someone Else", null]);
    await cast(s.id, [77, "Pat Actor", null]);
    await cast(other.id, [78, "Someone Else", null]);
    const page = await loadPersonPage(db, w.actor, adult, 77);
    expect(page).toMatchObject({ personId: 77, name: "Pat Actor" });
    expect(page!.items.map((i) => [i.name, i.kind, i.roles])).toEqual([["Newer", "movie", ["as Old Pat"]], ["Series", "show", ["Actor"]], ["Older", "movie", ["as Young Pat"]]]);
    expect(await loadPersonPage(db, w.actor, adult, 4040404)).toBeNull();
  });
  it("leaves out what this viewer can't see: age limit, restricted libraries, other servers, and other kinds of title", async () => {
    const w = await world();
    const open = await w.movie("Family Film");
    const adultOnly = await w.movie("Grown Up Film", { ratingAges: { ANY: 17 } });
    const restricted = await makeLibrary(db, w.server.id, "movies", "restricted");
    const hidden = await w.movie("Hidden Film", {}, restricted.id);
    const book = await makeTitle(db, w.lib.id, { kind: "audiobook", name: "A Reading", ratingAges: { ANY: 0 } });
    const w2 = await world();
    const elsewhere = await w2.movie("Other Server Film");
    for (const t of [open, adultOnly, hidden, book, elsewhere]) await cast(t.id, [90, "Shared Name", null]);
    expect((await loadPersonPage(db, w.actor, adult, 90))!.items.map((i) => i.name)).toEqual(["Family Film", "Grown Up Film"]);
    expect((await loadPersonPage(db, w.actor, kid, 90))!.items.map((i) => i.name)).toEqual(["Family Film"]);
    expect((await loadPersonPage(db, { ...w.actor, isAdmin: true }, adult, 90))!.items.map((i) => i.name).sort()).toEqual(["Family Film", "Grown Up Film", "Hidden Film"]);
    await db.update(libraries).set({ access: "restricted" }).where(eq(libraries.id, w.lib.id));
    expect(await loadPersonPage(db, w.actor, adult, 90)).toBeNull(); // nothing left that this member can see
  });
});

describe("the key crew", () => {
  const c = (id: number, name: string, job: string) => ({ id, name, job, department: "x", profile_path: `/c${id}.jpg` });
  it("keeps only the key jobs, a few people per job, most important first", () => {
    const crew = [
      c(1, "Gaffer", "Gaffer"),
      c(2, "Prod A", "Producer"), c(3, "Prod B", "Producer"), c(4, "Prod C", "Producer"), c(5, "Prod D", "Producer"), c(6, "Prod E", "Producer"),
      c(7, "Dir", "Director"),
      c(8, "Comp", "Original Music Composer"),
      c(7, "Dir", "Director"), // listed twice
      c(7, "Dir", "Screenplay"),
    ];
    expect(keyCrew(crew).map((x) => [x.name, x.job])).toEqual([["Dir", "Director"], ["Dir", "Screenplay"], ["Prod A", "Producer"], ["Prod B", "Producer"], ["Prod C", "Producer"], ["Prod D", "Producer"], ["Comp", "Original Music Composer"]]);
  });
  it("is stored with the cast, shown one card per person with all their jobs, and replaced on a refetch", async () => {
    const w = await world();
    const m = await w.movie("Crewed");
    h.credits.set(m.tmdbId!, [person(1, "Star")]);
    h.crew.set(m.tmdbId!, [c(7, "Ann Director", "Director"), c(7, "Ann Director", "Writer"), c(8, "Cy Composer", "Original Music Composer"), c(9, "Sound Guy", "Sound Designer")]);
    await backfillCast(w.lib.id, Date.now() + 60_000);
    expect(await loadTitleCrew(db, m.id)).toEqual([
      { personId: 7, name: "Ann Director", photoUrl: expect.stringContaining("/c7.jpg"), jobs: ["Director", "Writer"] },
      { personId: 8, name: "Cy Composer", photoUrl: expect.stringContaining("/c8.jpg"), jobs: ["Composer"] },
    ]);
    h.crew.set(m.tmdbId!, [c(10, "New Director", "Director")]);
    await db.update(titles).set({ castAttemptedAt: null }).where(eq(titles.id, m.id));
    await backfillCast(w.lib.id, Date.now() + 60_000);
    expect((await loadTitleCrew(db, m.id)).map((x) => x.name)).toEqual(["New Director"]);
  });
  it("puts a person's crew work on their page alongside any acting, for what the viewer may see", async () => {
    const w = await world();
    const a = await w.movie("Acted and Directed", { year: 2010 });
    const b = await w.movie("Only Directed", { year: 2018 });
    const hidden = await w.movie("Too Old For Kids", { year: 2020, ratingAges: { ANY: 17 } });
    await db.insert(titleCast).values({ titleId: a.id, personId: 55, name: "Both Hats", character: "The Lead", photoUrl: null, position: 0 });
    await db.insert(titleCrew).values([
      { titleId: a.id, personId: 55, name: "Both Hats", job: "Director", photoUrl: "https://img/55.jpg", position: 0 },
      { titleId: b.id, personId: 55, name: "Both Hats", job: "Original Music Composer", photoUrl: null, position: 0 },
      { titleId: hidden.id, personId: 55, name: "Both Hats", job: "Director", photoUrl: null, position: 0 },
    ]);
    const page = await loadPersonPage(db, w.actor, kid, 55);
    expect(page).toMatchObject({ name: "Both Hats", photoUrl: "https://img/55.jpg" });
    expect(page!.items.map((i) => [i.name, i.roles])).toEqual([["Only Directed", ["Composer"]], ["Acted and Directed", ["as The Lead", "Director"]]]);
    expect((await loadPersonPage(db, w.actor, adult, 55))!.items).toHaveLength(3);
    const onlyCrew = await w.movie("Crew Only");
    await db.insert(titleCrew).values({ titleId: onlyCrew.id, personId: 56, name: "Behind Camera", job: "Editor", photoUrl: null, position: 0 });
    expect((await loadPersonPage(db, w.actor, adult, 56))!.items.map((i) => i.roles)).toEqual([["Editor"]]);
  });
});
