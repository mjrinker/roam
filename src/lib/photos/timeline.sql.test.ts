/** The timeline, neighbours and photo detail queries: order, paging, ties, and what a viewer may not see. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AccessProfile } from "@/lib/content/access";
import { libraryMembers, mediaFiles, titles } from "@/lib/db/schema";
import { adminLib, createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { listTimeline, loadPhoto, photoNeighbors as neighbors, type TimelineCursor } from "./timeline";

/** Neighbours as ids, which is what most of these tests care about. */
async function photoNeighbors(ex: Parameters<typeof neighbors>[0], args: Parameters<typeof neighbors>[1]) {
  const r = await neighbors(ex, args);
  return { prev: r.prev?.id ?? null, next: r.next?.id ?? null };
}

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const everyone: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
let n = 0;
const iso = (s: string) => new Date(s);

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "m");
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const memberLib = { serverId: server.id, accountId: member.accountId, isAdmin: false };
  const add = (takenAt: string | null, over: Partial<typeof titles.$inferInsert> = {}) =>
    makeTitle(db, lib.id, { kind: "photo", boxFolderId: `file:t${++n}`, takenAt: takenAt ? iso(takenAt) : null, takenAtSource: "box", ...over });
  return { owner, server, member, lib, memberLib, add };
}

const ids = (page: { items: { id: string }[] } | null) => page!.items.map((i) => i.id);
const tl = (w: Awaited<ReturnType<typeof world>>, over: Partial<Parameters<typeof listTimeline>[1]> = {}) =>
  listTimeline(db, { actor: w.memberLib, viewer: everyone, libraryId: w.lib.id, ...over });

describe("timeline order and paging", () => {
  it("lists newest first, then by id for the same second, with pictures and videos together", async () => {
    const w = await world();
    const a = await w.add("2024-01-01T00:00:00Z");
    const b = await w.add("2024-03-01T00:00:00Z");
    const c = await w.add("2024-03-01T00:00:00Z", { kind: "movie", runtimeSeconds: 12 });
    const d = await w.add("2023-06-06T00:00:00Z");
    const page = await tl(w);
    const sameSecond = [b.id, c.id].sort().reverse();
    expect(ids(page)).toEqual([...sameSecond, a.id, d.id]);
    expect(page!.items.find((i) => i.id === c.id)).toMatchObject({ kind: "movie", runtimeSeconds: 12 });
    expect(page!.items[0].takenAt).toBe("2024-03-01T00:00:00.000Z");
  });

  it("pages without skipping or repeating anything, including a whole page of identical seconds and undated items last", async () => {
    const w = await world();
    const all: string[] = [];
    for (let i = 0; i < 7; i++) all.push((await w.add("2024-05-05T10:00:00Z")).id); // 7 in one second
    for (let i = 0; i < 4; i++) all.push((await w.add(`2023-0${i + 1}-01T00:00:00Z`)).id);
    for (let i = 0; i < 3; i++) all.push((await w.add(null)).id); // never dated
    const seen: string[] = [];
    let cursor: TimelineCursor | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await tl(w, { after: cursor, limit: 3 });
      seen.push(...ids(page));
      cursor = page!.next;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(new Set(seen)).toEqual(new Set(all));
    // dated items come first (newest first), undated last
    const dated = await Promise.all(seen.map(async (id) => (await db.select().from(titles).where(eq(titles.id, id)))[0].takenAt));
    const firstNull = dated.findIndex((d) => d === null);
    expect(firstNull).toBe(11);
    expect(dated.slice(0, 11).every((d, i, a) => i === 0 || d!.getTime() <= a[i - 1]!.getTime())).toBe(true);
  });

  it("the cursor is exact to the second: items a second apart are never confused", async () => {
    const w = await world();
    const a = await w.add("2024-05-05T10:00:01Z");
    const b = await w.add("2024-05-05T10:00:00Z");
    const first = await tl(w, { limit: 1 });
    expect(ids(first)).toEqual([a.id]);
    expect(ids(await tl(w, { after: first!.next, limit: 5 }))).toEqual([b.id]);
  });

  it("clamps the page size", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await w.add(`2024-01-0${i + 1}T00:00:00Z`);
    expect((await tl(w, { limit: 0 }))!.items).toHaveLength(1);
    expect((await tl(w, { limit: 9999 }))!.items).toHaveLength(3);
  });
});

describe("what a viewer may not see", () => {
  it("returns null for a library that isn't a photo library, one that doesn't exist, and a restricted one the account wasn't given", async () => {
    const w = await world();
    const video = await makeLibrary(db, w.server.id, "video", "everyone");
    const restricted = await makeLibrary(db, w.server.id, "photos", "restricted");
    await makeTitle(db, restricted.id, { kind: "photo", boxFolderId: `file:r${++n}`, takenAt: iso("2024-01-01T00:00:00Z") });
    // a video library WITH items (even ones dated, as if mislabelled) is still not a photo library
    await makeTitle(db, video.id, { kind: "movie", boxFolderId: `file:vl${++n}`, takenAt: iso("2024-01-01T00:00:00Z") });
    expect(await tl(w, { libraryId: video.id })).toBeNull();
    expect(await tl(w, { libraryId: "00000000-0000-4000-8000-0000000000cc" })).toBeNull();
    expect(await tl(w, { libraryId: restricted.id })).toBeNull();
    // granted: visible; the admin always sees it
    await db.insert(libraryMembers).values({ libraryId: restricted.id, accountId: w.member.accountId, serverId: w.server.id });
    expect((await tl(w, { libraryId: restricted.id }))!.items).toHaveLength(1);
    expect((await listTimeline(db, { actor: adminLib(w.server.id), viewer: everyone, libraryId: restricted.id }))!.items).toHaveLength(1);
  });

  it("an empty visible photo library is an empty page, not a missing one", async () => {
    const w = await world();
    expect(await tl(w)).toEqual({ items: [], next: null, prev: null });
  });

  it("never shows an item above the viewer's age limit, and never lets it count toward paging", async () => {
    const w = await world();
    const ok = await w.add("2024-01-01T00:00:00Z", { ratingAges: { ANY: 8 } as never });
    const blocked = await w.add("2024-06-01T00:00:00Z", { ratingAges: { ANY: 18 } as never });
    const kid = { locale: "en-US", maxAge: 12, allowUnrated: false };
    const page = await tl(w, { viewer: kid, limit: 1 });
    expect(ids(page)).toEqual([ok.id]);
    expect(page!.next).toBeNull(); // the blocked item isn't a "next page"
    expect(ids(await tl(w, { viewer: kid }))).not.toContain(blocked.id);
  });

  it("another server's account sees nothing", async () => {
    const w = await world();
    const stranger = await makeAccount(db, "s");
    const other = await makeServer(db, stranger.accountId);
    await w.add("2024-01-01T00:00:00Z");
    expect(await listTimeline(db, { actor: { serverId: other.id, accountId: stranger.accountId, isAdmin: true }, viewer: everyone, libraryId: w.lib.id })).toBeNull();
  });
});

describe("loadPhoto", () => {
  it("loads a picture or a video beside it (with its file details), but not a missing id, another library kind, a hidden library or a blocked title", async () => {
    const w = await world();
    const photo = await w.add("2024-01-01T00:00:00Z", { name: "Beach", folderPath: "Trip/Day 1" });
    const clip = await w.add("2024-01-02T00:00:00Z", { kind: "movie" });
    const blocked = await w.add("2024-01-03T00:00:00Z", { ratingAges: { ANY: 18 } as never });
    const video = await makeLibrary(db, w.server.id, "video", "everyone");
    const stray = await makeTitle(db, video.id, { kind: "photo", boxFolderId: `file:v${++n}` });
    const load = (id: string, viewer = everyone) => loadPhoto(db, { actor: w.memberLib, viewer, id });
    expect(await load(photo.id)).toMatchObject({ id: photo.id, name: "Beach", folderPath: "Trip/Day 1", libraryId: w.lib.id });
    expect(await load(clip.id)).toMatchObject({ id: clip.id, kind: "movie", libraryId: w.lib.id });
    for (const id of [stray.id, "00000000-0000-4000-8000-0000000000dd"]) expect(await load(id), id).toBeNull();
    const detailed = await makeTitle(db, w.lib.id, { kind: "photo", boxFolderId: `file:d${++n}`, takenAt: iso("2024-01-05T00:00:00Z") });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: detailed.id, partIndex: 0, boxFileId: `bx${n}`, filename: "IMG_0001.HEIC", sizeBytes: 3_453_641, container: "heic", probeStatus: "ok" });
    expect(await load(detailed.id)).toMatchObject({ filename: "IMG_0001.HEIC", sizeBytes: 3_453_641, container: "heic", kind: "photo" });
    expect(await load(blocked.id, { locale: "en-US", maxAge: 12, allowUnrated: false })).toBeNull();
    const restricted = await makeLibrary(db, w.server.id, "photos", "restricted");
    const hidden = await makeTitle(db, restricted.id, { kind: "photo", boxFolderId: `file:h${++n}` });
    expect(await load(hidden.id)).toBeNull();
  });
});

describe("neighbours", () => {
  it("timeline: the older item is next, the newer is prev, videos are part of the sequence, ends have none", async () => {
    const w = await world();
    const p1 = await w.add("2024-01-01T00:00:00Z");
    const clip = await w.add("2024-02-01T00:00:00Z", { kind: "movie" });
    const p2 = await w.add("2024-03-01T00:00:00Z");
    const p3 = await w.add("2024-04-01T00:00:00Z");
    const around = async (p: typeof p1) => photoNeighbors(db, { actor: w.memberLib, viewer: everyone, photo: (await loadPhoto(db, { actor: w.memberLib, viewer: everyone, id: p.id }))!, scope: { kind: "timeline" } });
    expect(await around(p2)).toEqual({ prev: p3.id, next: clip.id });
    expect(await around(p3)).toEqual({ prev: null, next: p2.id });
    expect(await around(p1)).toEqual({ prev: clip.id, next: null });
    expect(await around(clip as typeof p1)).toEqual({ prev: p2.id, next: p1.id });
  });

  it("timeline: pictures from the same second keep a stable order through ids", async () => {
    const w = await world();
    const same = [await w.add("2024-01-01T00:00:00Z"), await w.add("2024-01-01T00:00:00Z"), await w.add("2024-01-01T00:00:00Z")];
    const order = ids(await tl(w));
    for (let i = 0; i < 3; i++) {
      const photo = (await loadPhoto(db, { actor: w.memberLib, viewer: everyone, id: order[i] }))!;
      const nb = await photoNeighbors(db, { actor: w.memberLib, viewer: everyone, photo, scope: { kind: "timeline" } });
      expect(nb).toEqual({ prev: order[i - 1] ?? null, next: order[i + 1] ?? null });
    }
    expect(same).toHaveLength(3);
  });

  it("never offers an item the viewer may not see as a neighbour (age-blocked photos are skipped over)", async () => {
    const w = await world();
    const a = await w.add("2024-01-01T00:00:00Z", { ratingAges: { ANY: 8 } as never });
    const blocked = await w.add("2024-02-01T00:00:00Z", { ratingAges: { ANY: 18 } as never });
    const c = await w.add("2024-03-01T00:00:00Z", { ratingAges: { ANY: 8 } as never });
    const kid = { locale: "en-US", maxAge: 12, allowUnrated: false };
    const photo = (await loadPhoto(db, { actor: w.memberLib, viewer: kid, id: c.id }))!;
    const nb = await photoNeighbors(db, { actor: w.memberLib, viewer: kid, photo, scope: { kind: "timeline" } });
    expect(nb).toEqual({ prev: null, next: a.id });
    expect(Object.values(nb)).not.toContain(blocked.id);
  });

  it("folder: neighbours are by name within the same folder only", async () => {
    const w = await world();
    const mk = (name: string, folderPath: string) => w.add("2024-01-01T00:00:00Z", { name, sortKey: name.toLowerCase(), folderPath });
    const a = await mk("a", "Trip");
    const b = await mk("b", "Trip");
    await mk("ab", "Other");
    const c = await mk("c", "Trip");
    const photo = (await loadPhoto(db, { actor: w.memberLib, viewer: everyone, id: b.id }))!;
    expect(await photoNeighbors(db, { actor: w.memberLib, viewer: everyone, photo, scope: { kind: "folder", path: "Trip" } })).toEqual({ prev: a.id, next: c.id });
  });

  it("an undated picture has no timeline neighbours", async () => {
    const w = await world();
    const undated = await w.add(null);
    await w.add("2024-01-01T00:00:00Z");
    const photo = (await loadPhoto(db, { actor: w.memberLib, viewer: everyone, id: undated.id }))!;
    expect(await photoNeighbors(db, { actor: w.memberLib, viewer: everyone, photo, scope: { kind: "timeline" } })).toEqual({ prev: null, next: null });
  });
});
