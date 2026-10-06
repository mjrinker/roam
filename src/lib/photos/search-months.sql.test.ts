/** Search, month jumping and month counts: one narrowing for all of them, and nothing a viewer may not see. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessProfile } from "@/lib/content/access";
import { libraryMembers, photoFavorites, titles } from "@/lib/db/schema";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { parseSearch } from "./search";
import { listMonths, listTimeline } from "./timeline";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const open: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
let n = 0;
async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "m");
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const actor = { serverId: server.id, accountId: member.accountId, isAdmin: false };
  const add = (name: string, takenAt: string | null, over: Partial<typeof titles.$inferInsert> = {}) =>
    makeTitle(db, lib.id, { kind: "photo", name, boxFolderId: `file:s${++n}`, takenAt: takenAt ? new Date(takenAt) : null, takenAtSource: "box", ...over });
  const list = (over: Partial<Parameters<typeof listTimeline>[1]> = {}) => listTimeline(db, { actor, viewer: open, viewerId: member.accountId, libraryId: lib.id, ...over });
  const months = (over: Partial<Parameters<typeof listMonths>[1]> = {}) => listMonths(db, { actor, viewer: open, viewerId: member.accountId, libraryId: lib.id, ...over });
  return { owner, server, member, lib, actor, add, list, months };
}
const names = (p: { items: { name: string }[] } | null) => p!.items.map((i) => i.name);

describe("search", () => {
  it("matches names case-insensitively, anywhere in the name", async () => {
    const w = await world();
    await w.add("Beach Day", "2024-01-01T00:00:00Z");
    await w.add("beach_sunset", "2024-01-02T00:00:00Z");
    await w.add("Mountain", "2024-01-03T00:00:00Z");
    expect(names(await w.list({ search: parseSearch("BEACH") }))).toEqual(["beach_sunset", "Beach Day"]);
    expect(names(await w.list({ search: parseSearch("ount") }))).toEqual(["Mountain"]);
    expect(names(await w.list({ search: parseSearch("zzz") }))).toEqual([]);
  });

  it("treats % _ and backslash in a query as ordinary characters, never wildcards", async () => {
    const w = await world();
    await w.add("100% sure", "2024-01-01T00:00:00Z");
    await w.add("a_b", "2024-01-02T00:00:00Z");
    await w.add("axb", "2024-01-03T00:00:00Z");
    await w.add("back\\slash", "2024-01-04T00:00:00Z");
    await w.add("plain", "2024-01-05T00:00:00Z");
    expect(names(await w.list({ search: parseSearch("%") }))).toEqual(["100% sure"]);
    expect(names(await w.list({ search: parseSearch("a_b") }))).toEqual(["a_b"]); // not a? b with any middle character
    expect(names(await w.list({ search: parseSearch("\\") }))).toEqual(["back\\slash"]);
    expect(names(await w.list({ search: parseSearch("'; drop table titles; --") }))).toEqual([]);
  });

  it("a date query finds what was taken in that period, together with names that contain it", async () => {
    const w = await world();
    await w.add("IMG_2024", "2019-06-01T00:00:00Z");
    await w.add("new year", "2024-01-01T00:00:00Z");
    await w.add("last second", "2024-12-31T23:59:59Z");
    await w.add("next year", "2025-01-01T00:00:00Z");
    await w.add("old", "2023-12-31T23:59:59Z");
    expect(names(await w.list({ search: parseSearch("2024") })).sort()).toEqual(["IMG_2024", "last second", "new year"]);
    expect(names(await w.list({ search: parseSearch("2024-01") }))).toEqual(["new year"]);
    expect(names(await w.list({ search: parseSearch("January 2024") }))).toEqual(["new year"]);
    expect(names(await w.list({ search: parseSearch("2024-12-31") }))).toEqual(["last second"]);
  });

  it("pages with a search, never repeating or skipping, and never shows what the viewer may not see", async () => {
    const w = await world();
    for (let i = 0; i < 7; i++) await w.add(`holiday ${i}`, `2024-05-0${i + 1}T00:00:00Z`);
    await w.add("holiday secret", "2024-06-01T00:00:00Z", { ratingAges: { ANY: 18 } as never });
    await w.add("other", "2024-07-01T00:00:00Z");
    const kid: AccessProfile = { locale: "en-US", maxAge: 12, allowUnrated: true };
    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof w.list>> extends infer P ? (P extends { next: infer C } ? C : never) : never;
    for (let guard = 0; guard < 10; guard++) {
      const page = await w.list({ search: parseSearch("holiday"), after: cursor, limit: 3, viewer: kid });
      seen.push(...names(page));
      cursor = page!.next;
      if (!cursor) break;
    }
    expect(seen).toEqual(["holiday 6", "holiday 5", "holiday 4", "holiday 3", "holiday 2", "holiday 1", "holiday 0"]);
  });

  it("combines with the favorites view", async () => {
    const w = await world();
    const a = await w.add("beach 1", "2024-01-01T00:00:00Z");
    await w.add("beach 2", "2024-01-02T00:00:00Z");
    const c = await w.add("city", "2024-01-03T00:00:00Z");
    await db.insert(photoFavorites).values([{ viewerId: w.member.accountId, titleId: a.id }, { viewerId: w.member.accountId, titleId: c.id }]);
    expect(names(await w.list({ search: parseSearch("beach"), favoritesOnly: true }))).toEqual(["beach 1"]);
  });
});

describe("jumping to a month", () => {
  it("starts at that month (newest of it first) and continues to older ones, then undated", async () => {
    const w = await world();
    await w.add("apr", "2024-04-15T00:00:00Z");
    await w.add("mar-late", "2024-03-31T23:59:59Z");
    await w.add("mar-early", "2024-03-01T00:00:00Z");
    await w.add("feb", "2024-02-10T00:00:00Z");
    await w.add("none", null);
    expect(names(await w.list({ month: "2024-03" }))).toEqual(["mar-late", "mar-early", "feb", "none"]);
    expect(names(await w.list({ month: "2024-04" }))).toEqual(["apr", "mar-late", "mar-early", "feb", "none"]);
    expect(names(await w.list({ month: "undated" }))).toEqual(["none"]);
  });
  it("ignores a month it can't read (the whole timeline), rather than failing", async () => {
    const w = await world();
    await w.add("a", "2024-04-15T00:00:00Z");
    for (const bad of ["", "2024-13", "2024-00", "abc", "2024-3", "'; --", "0000-01", "99999-01"]) expect(names(await w.list({ month: bad })), bad).toEqual(["a"]);
  });
});

describe("month counts", () => {
  it("count what is visible per month, newest first with undated last, in UTC", async () => {
    const w = await world();
    await w.add("a", "2024-03-31T23:59:59Z");
    await w.add("b", "2024-03-01T00:00:00Z");
    await w.add("c", "2024-02-29T12:00:00Z");
    await w.add("d", "2023-12-25T00:00:00Z");
    await w.add("e", null);
    await w.add("f", null);
    expect(await w.months()).toEqual([{ key: "2024-03", count: 2 }, { key: "2024-02", count: 1 }, { key: "2023-12", count: 1 }, { key: "undated", count: 2 }]);
  });
  it("use the same narrowing as the listing: age limit, search, favorites", async () => {
    const w = await world();
    const a = await w.add("beach", "2024-03-05T00:00:00Z", { ratingAges: { ANY: 8 } as never });
    await w.add("beach blocked", "2024-03-06T00:00:00Z", { ratingAges: { ANY: 18 } as never });
    await w.add("city", "2024-02-06T00:00:00Z", { ratingAges: { ANY: 8 } as never });
    await db.insert(photoFavorites).values({ viewerId: w.member.accountId, titleId: a.id });
    const kid: AccessProfile = { locale: "en-US", maxAge: 12, allowUnrated: false };
    expect(await w.months({ viewer: kid })).toEqual([{ key: "2024-03", count: 1 }, { key: "2024-02", count: 1 }]);
    expect(await w.months({ viewer: kid, search: parseSearch("beach") })).toEqual([{ key: "2024-03", count: 1 }]);
    expect(await w.months({ viewer: kid, favoritesOnly: true })).toEqual([{ key: "2024-03", count: 1 }]);
    expect(await w.months({ favoritesOnly: true, viewerId: undefined })).toEqual([]);
  });
  it("is null for a library that isn't a visible photo library", async () => {
    const w = await world();
    const video = await makeLibrary(db, w.server.id, "video", "everyone");
    const restricted = await makeLibrary(db, w.server.id, "photos", "restricted");
    await makeTitle(db, restricted.id, { kind: "photo", boxFolderId: `file:r${++n}`, takenAt: new Date("2024-01-01T00:00:00Z") });
    expect(await w.months({ libraryId: video.id })).toBeNull();
    expect(await w.months({ libraryId: restricted.id })).toBeNull();
    await db.insert(libraryMembers).values({ libraryId: restricted.id, accountId: w.member.accountId, serverId: w.server.id });
    expect(await w.months({ libraryId: restricted.id })).toEqual([{ key: "2024-01", count: 1 }]);
    expect(await w.months({ libraryId: "00000000-0000-4000-8000-0000000000ab" })).toBeNull();
  });
});
