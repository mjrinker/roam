/** Watch statistics: counting time, and what the admin sees (households only, never a single profile). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { watchActivity } from "@/lib/db/schema";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { dayOf, MAX_PER_SAVE_SECONDS, recordWatch, secondsWatched } from "./record";
import { fillDays, formatHours, households, householdDetail, overview, parseRange, sinceDay } from "./queries";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const NOW = new Date("2026-10-17T12:00:00Z");
let n = 0;
async function world() {
  const admin = await makeAccount(db, `st${++n}`);
  const server = await makeServer(db, admin.accountId);
  const a = await makeAccount(db, `sta${++n}`);
  const b = await makeAccount(db, `stb${++n}`);
  await joinServer(db, server.id, a.accountId);
  await joinServer(db, server.id, b.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const books = await makeLibrary(db, server.id, "audiobooks", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  const other = await makeTitle(db, movies.id, { kind: "movie", name: "Other film" });
  const { show, episodes } = await makeShow(db, shows.id, 2, { name: "Show" });
  const book = await makeTitle(db, books.id, { kind: "audiobook", name: "Book" });
  return { admin, server, a, b, film, other, show, episodes, book, members: [{ accountId: admin.accountId }, { accountId: a.accountId }, { accountId: b.accountId }] };
}

describe("counting a save", () => {
  const prev = (positionSeconds: number, secondsAgo: number) => ({ positionSeconds, savedAt: new Date(NOW.getTime() - secondsAgo * 1000) });
  it("counts how far it moved, limited by real time at up to 4x and by a ceiling", () => {
    expect(secondsWatched(prev(100, 15), 115, NOW)).toBe(15);
    expect(secondsWatched(prev(100, 15), 130, NOW)).toBe(30); // 2x
    expect(secondsWatched(prev(100, 15), 1000, NOW)).toBe(60); // a jump ahead: 4x of the time that passed
    expect(secondsWatched(prev(0, 3600), 5000, NOW)).toBe(MAX_PER_SAVE_SECONDS); // a long pause, then a jump
    expect(secondsWatched(prev(100, 15), 115.9, NOW)).toBe(15);
  });
  it("counts nothing for the first save, going back, standing still, or no time passing", () => {
    expect(secondsWatched(null, 500, NOW)).toBe(0);
    expect(secondsWatched(prev(100, 15), 90, NOW)).toBe(0);
    expect(secondsWatched(prev(100, 15), 100, NOW)).toBe(0);
    expect(secondsWatched(prev(100, 0), 160, NOW)).toBe(0);
  });
});

describe("recording and reading", () => {
  it("adds up a household's time per day and title, counting an episode for its show", async () => {
    const w = await world();
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: w.film.id, seconds: 600, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: w.film.id, seconds: 300, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "episode", ownerId: w.episodes[0].id, seconds: 1200, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "episode", ownerId: w.episodes[1].id, seconds: 1300, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: w.film.id, seconds: 100, now: new Date("2026-10-16T08:00:00Z") });
    const rows = await db.select().from(watchActivity).where(eq(watchActivity.accountId, w.a.accountId));
    expect(rows.map((r) => [r.day, r.titleId === w.film.id ? "film" : "show", r.seconds]).sort()).toEqual([["2026-10-16", "film", 100], ["2026-10-17", "film", 900], ["2026-10-17", "show", 2500]]);
  });

  it("records nothing for no time, a title on another server, or an unknown id", async () => {
    const w = await world();
    const elsewhere = await world();
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: w.film.id, seconds: 0, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: elsewhere.film.id, seconds: 500, now: NOW });
    await recordWatch(db, { serverId: w.server.id, accountId: w.a.accountId, ownerKind: "title", ownerId: "123e4567-e89b-42d3-a456-426614174000", seconds: 500, now: NOW });
    expect(await db.select().from(watchActivity).where(eq(watchActivity.serverId, w.server.id))).toEqual([]);
  });

  it("gives the admin totals, a zero-filled daily chart and the most watched with only a count of households", async () => {
    const w = await world();
    const rec = (accountId: string, ownerId: string, seconds: number, day: string, kind: "title" | "episode" = "title") => recordWatch(db, { serverId: w.server.id, accountId, ownerKind: kind, ownerId, seconds, now: new Date(`${day}T10:00:00Z`) });
    await rec(w.a.accountId, w.film.id, 3600, "2026-10-17");
    await rec(w.b.accountId, w.film.id, 1800, "2026-10-15");
    await rec(w.a.accountId, w.other.id, 600, "2026-10-17");
    await rec(w.b.accountId, w.book.id, 7200, "2026-10-16");
    await rec(w.a.accountId, w.film.id, 99999, "2026-09-01"); // outside a week
    const o = await overview(db, { serverId: w.server.id, days: 7, now: NOW });
    expect(o).toMatchObject({ totalSeconds: 13200, watchSeconds: 6000, listenSeconds: 7200, activeHouseholds: 2, titles: 3 });
    expect(o.byDay).toHaveLength(7);
    expect(o.byDay.map((d) => d.day)[6]).toBe("2026-10-17");
    expect(o.byDay.find((d) => d.day === "2026-10-17")?.seconds).toBe(4200);
    expect(o.byDay.find((d) => d.day === "2026-10-14")?.seconds).toBe(0);
    expect(o.top.map((t) => [t.name, t.seconds, t.households])).toEqual([["Book", 7200, 1], ["Film", 5400, 2], ["Other film", 600, 1]]);
    expect(JSON.stringify(o)).not.toMatch(/accountId|account_id|viewer/i); // no one's name or id is in it
    const year = await overview(db, { serverId: w.server.id, days: 365, now: NOW });
    expect(year.totalSeconds).toBe(13200 + 99999);
  });

  it("lists every household with its time, the most first, and shows what one household watched", async () => {
    const w = await world();
    const rec = (accountId: string, ownerId: string, seconds: number, day: string) => recordWatch(db, { serverId: w.server.id, accountId, ownerKind: "title", ownerId, seconds, now: new Date(`${day}T10:00:00Z`) });
    await rec(w.a.accountId, w.film.id, 3600, "2026-10-17");
    await rec(w.a.accountId, w.other.id, 600, "2026-10-12");
    await rec(w.b.accountId, w.film.id, 100, "2026-10-14");
    const rows = await households(db, { serverId: w.server.id, days: 30, members: w.members, now: NOW });
    expect(rows.map((r) => [r.accountId, r.seconds, r.titles, r.lastDay])).toEqual([[w.a.accountId, 4200, 2, "2026-10-17"], [w.b.accountId, 100, 1, "2026-10-14"], [w.admin.accountId, 0, 0, null]]);
    const detail = await householdDetail(db, { serverId: w.server.id, accountId: w.a.accountId, days: 30, isMember: true, now: NOW });
    expect(detail?.totalSeconds).toBe(4200);
    expect(detail?.top.map((t) => [t.name, t.seconds])).toEqual([["Film", 3600], ["Other film", 600]]);
    expect(detail?.byDay).toHaveLength(30);
    expect(await householdDetail(db, { serverId: w.server.id, accountId: w.a.accountId, days: 30, isMember: false, now: NOW })).toBeNull();
  });

  it("keeps servers apart", async () => {
    const w = await world();
    const x = await world();
    await recordWatch(db, { serverId: x.server.id, accountId: x.a.accountId, ownerKind: "title", ownerId: x.film.id, seconds: 5000, now: NOW });
    expect((await overview(db, { serverId: w.server.id, days: 30, now: NOW })).totalSeconds).toBe(0);
    expect((await households(db, { serverId: w.server.id, days: 30, members: w.members, now: NOW })).every((h) => h.seconds === 0)).toBe(true);
  });
});

describe("the helpers", () => {
  it("reads a range, falls back to 30 days, and fills missing days", () => {
    expect([7, 30, 90, 365].map(parseRange)).toEqual([7, 30, 90, 365]);
    expect(["x", 5, undefined, "90"].map(parseRange)).toEqual([30, 30, 30, 90]);
    expect(sinceDay(7, NOW)).toBe("2026-10-11");
    expect(fillDays([{ day: "2026-10-16", seconds: 60 }], 3, NOW)).toEqual([{ day: "2026-10-15", seconds: 0 }, { day: "2026-10-16", seconds: 60 }, { day: "2026-10-17", seconds: 0 }]);
    expect(dayOf(new Date("2026-03-01T23:59:59Z"))).toBe("2026-03-01");
  });
  it("writes times for people", () => {
    expect([0, 40, 90, 3600, 3660, 5400 + 1800].map(formatHours)).toEqual(["0m", "1m", "2m", "1h", "1h 1m", "2h"]);
  });
});
