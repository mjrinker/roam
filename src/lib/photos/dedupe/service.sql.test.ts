/** Finding and hiding duplicate photos: fingerprinting in batches, grouping, hiding and restoring, and that hidden copies leave the listings. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { photoFavorites, titles } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { listMonths, listTimeline } from "@/lib/photos/timeline";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { mediaFiles } from "@/lib/db/schema";
import { distance } from "./hash";
import { DISTANCES, duplicateGroups, hashBatch, hashImage, hashProgress, hiddenDuplicates, hideDuplicates, restoreDuplicates, RETRY_AFTER_MS, type HashDeps } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
let n = 0;

async function world() {
  const admin = await makeAccount(db, `pd${++n}`);
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: admin.accountId, isAdmin: true };
  async function photo(name: string, o: { size?: number; w?: number; h?: number; takenAt?: Date } = {}) {
    const [t] = await db.insert(titles).values({ libraryId: lib.id, kind: "photo", name, boxFolderId: `p${++n}`, width: o.w ?? 1000, height: o.h ?? 800, takenAt: o.takenAt ?? new Date("2020-05-05T10:00:00Z"), folderPath: "" }).returning();
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `file-${t.id}`, filename: `${name}.jpg`, sizeBytes: o.size ?? 1000, container: "jpg" });
    return t;
  }
  return { admin, server, lib, actor, photo };
}

/** Fake storage: each photo's "thumbnail" is a string naming its hash. */
function deps(hashes: Record<string, string | null>, opts: { budget?: number } = {}): HashDeps & { asked: string[]; spent: number } {
  const state = { asked: [] as string[], spent: 0 };
  return {
    get asked() { return state.asked; },
    get spent() { return state.spent; },
    fetchThumbnail: async (_s, fileId) => (state.asked.push(fileId), hashes[fileId] === undefined ? null : { bytes: new TextEncoder().encode(hashes[fileId] ?? "bad") }),
    hash: async (bytes) => { const t = new TextDecoder().decode(bytes); return t === "bad" ? null : t; },
    spend: async () => (++state.spent <= (opts.budget ?? 1e9)),
  };
}
const fileOf = (id: string) => `file-${id}`;

describe("fingerprinting", () => {
  it("gives the same fingerprint to a resized, re-saved copy of a picture and a very different one to another picture", async () => {
    const scene = (variant: number) => {
      const w = 240;
      const h = 160;
      const px = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        const blob = Math.hypot(x - (variant ? 60 : 170), y - (variant ? 110 : 50)) < 40 ? 255 : 0;
        const v = Math.min(255, Math.floor((x / w) * 140 + (y / h) * 60) + blob);
        px[o] = v; px[o + 1] = (v * 3) % 256; px[o + 2] = 255 - v;
      }
      return sharp(px, { raw: { width: w, height: h, channels: 3 } });
    };
    const original = await scene(0).jpeg({ quality: 95 }).toBuffer();
    const copy = await sharp(original).resize(120, 80).jpeg({ quality: 50 }).toBuffer();
    const other = await scene(1).jpeg({ quality: 95 }).toBuffer();
    const [a, b, c] = [await hashImage(original), await hashImage(copy), await hashImage(other)];
    expect(distance(a!, b!)).toBeLessThanOrEqual(DISTANCES.exact);
    expect(distance(a!, c!)).toBeGreaterThan(DISTANCES.loose);
    expect(await hashImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("fingerprints the pictures not yet done, a batch at a time, and counts progress", async () => {
    const w = await world();
    const ps = [await w.photo("a"), await w.photo("b"), await w.photo("c")];
    const d = deps({ [fileOf(ps[0].id)]: "0000000000000001", [fileOf(ps[1].id)]: "0000000000000001", [fileOf(ps[2].id)]: "ffffffffffffffff" });
    expect(await hashProgress(db, w.lib.id)).toEqual({ total: 3, checked: 0, failed: 0 });
    const first = await hashBatch(db, { libraryId: w.lib.id, limit: 2, deps: d });
    expect(first).toMatchObject({ hashed: 2, failed: 0, total: 3, checked: 2 });
    const second = await hashBatch(db, { libraryId: w.lib.id, limit: 2, deps: d });
    expect(second).toMatchObject({ hashed: 1, checked: 3 });
    expect(d.asked).toHaveLength(3); // each fetched once
    expect((await hashBatch(db, { libraryId: w.lib.id, limit: 10, deps: d })).hashed).toBe(0);
  });

  it("leaves a picture it couldn't read for a week, then tries it again; ignores videos and other libraries' pictures", async () => {
    const w = await world();
    const bad = await w.photo("bad");
    const clip = await w.photo("clip");
    await db.update(titles).set({ kind: "movie" }).where(eq(titles.id, clip.id));
    const d = deps({ [fileOf(bad.id)]: null, [fileOf(clip.id)]: "0000000000000000" });
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(await hashBatch(db, { libraryId: w.lib.id, limit: 10, deps: d, now: t0 })).toMatchObject({ hashed: 0, failed: 1 });
    expect(await hashProgress(db, w.lib.id)).toEqual({ total: 1, checked: 0, failed: 1 });
    await hashBatch(db, { libraryId: w.lib.id, limit: 10, deps: d, now: new Date(t0.getTime() + RETRY_AFTER_MS - 1000) });
    expect(d.asked).toEqual([fileOf(bad.id)]); // not again yet
    d.asked.length = 0;
    await hashBatch(db, { libraryId: w.lib.id, limit: 10, deps: d, now: new Date(t0.getTime() + RETRY_AFTER_MS + 1000) });
    expect(d.asked).toEqual([fileOf(bad.id)]);
  });

  it("stops when the server's photo budget is used up, leaving the rest for next time", async () => {
    const w = await world();
    const ps = [await w.photo("a"), await w.photo("b"), await w.photo("c")];
    const map = Object.fromEntries(ps.map((p) => [fileOf(p.id), "0000000000000000"]));
    const r = await hashBatch(db, { libraryId: w.lib.id, limit: 10, deps: deps(map, { budget: 2 }), concurrency: 1 });
    expect(r).toMatchObject({ hashed: 2, budgetUsedUp: true, checked: 2, total: 3 });
  });
});

describe("groups, hiding and restoring", () => {
  async function checked() {
    const w = await world();
    const big = await w.photo("IMG_1.jpg", { size: 5000, w: 4000, h: 3000 });
    const small = await w.photo("IMG_1 copy.jpg", { size: 900, w: 800, h: 600 });
    const edit = await w.photo("IMG_1 edit.jpg", { size: 4000, w: 4000, h: 3000 });
    const lone = await w.photo("other.jpg");
    const hashes = { [fileOf(big.id)]: "123456789abcdef0", [fileOf(small.id)]: "123456789abcdef0", [fileOf(edit.id)]: "123456789abcdeff", [fileOf(lone.id)]: "fedcba9876543210" };
    await hashBatch(db, { libraryId: w.lib.id, limit: 50, deps: deps(hashes) });
    return { w, big, small, edit, lone };
  }

  it("groups pictures that look alike, calls identical ones exact and loose ones similar, and suggests the biggest to keep", async () => {
    const { w, big, small, edit, lone } = await checked();
    const exact = await duplicateGroups(db, { libraryId: w.lib.id, maxDistance: DISTANCES.exact });
    expect(exact).toHaveLength(1);
    expect(exact[0].items.map((i) => i.id).sort()).toEqual([big.id, small.id].sort());
    expect(exact[0]).toMatchObject({ match: "exact", keepId: big.id });
    expect(exact[0].items[0].id).toBe(big.id); // the one to keep first
    const similar = await duplicateGroups(db, { libraryId: w.lib.id, maxDistance: DISTANCES.similar });
    expect(similar).toHaveLength(1);
    expect(similar[0].items.map((i) => i.id).sort()).toEqual([big.id, small.id, edit.id].sort());
    expect(similar[0]).toMatchObject({ match: "similar", keepId: big.id });
    expect(similar[0].items.every((i) => i.id !== lone.id)).toBe(true);
    expect(similar[0].items[0].thumbUrl).toMatch(new RegExp(`^/api/photos/${big.id}/thumb\\?v=`));
    expect(await duplicateGroups(db, { libraryId: w.lib.id, maxDistance: 0 })).toHaveLength(1); // identical hashes still group
  });

  it("hides the copies, moves hearts to the one kept, leaves them out of the timeline and months, and lists them as hidden", async () => {
    const { w, big, small, edit } = await checked();
    const kid = await makeAccount(db, `pdkid${++n}`);
    await joinServer(db, w.server.id, kid.accountId);
    await db.insert(photoFavorites).values([{ viewerId: kid.viewer.id, titleId: small.id }, { viewerId: w.admin.viewer.id, titleId: big.id }]);
    const before = await listTimeline(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id, viewerId: w.admin.viewer.id });
    expect(before?.items).toHaveLength(4);
    expect(await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [small.id, edit.id] })).toEqual({ ok: true, hidden: 2 });
    const after = await listTimeline(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id, viewerId: w.admin.viewer.id });
    expect(after?.items.map((i) => i.id)).not.toContain(small.id);
    expect(after?.items.map((i) => i.id)).not.toContain(edit.id);
    expect(after?.items).toHaveLength(2);
    expect((await listMonths(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id }))?.reduce((c, m) => c + m.count, 0)).toBe(2);
    expect((await db.select().from(photoFavorites).where(eq(photoFavorites.titleId, big.id))).map((f) => f.viewerId).sort()).toEqual([kid.viewer.id, w.admin.viewer.id].sort());
    expect(await duplicateGroups(db, { libraryId: w.lib.id, maxDistance: DISTANCES.loose })).toEqual([]); // hidden ones are not offered again
    const hidden = await hiddenDuplicates(db, w.lib.id);
    expect(hidden.map((h) => [h.name, h.keptId, h.keptName]).sort()).toEqual([["IMG_1 copy.jpg", big.id, "IMG_1.jpg"], ["IMG_1 edit.jpg", big.id, "IMG_1.jpg"]]);
    expect(await db.select({ id: titles.id }).from(titles).where(eq(titles.id, small.id))).toHaveLength(1); // nothing was deleted
  });

  it("restores hidden copies to the timeline", async () => {
    const { w, big, small } = await checked();
    await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [small.id] });
    expect(await restoreDuplicates(db, { libraryId: w.lib.id, ids: [small.id, big.id] })).toBe(1); // the one that was not hidden is not counted
    expect((await listTimeline(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id }))?.items).toHaveLength(4);
    expect(await hiddenDuplicates(db, w.lib.id)).toEqual([]);
    expect(await restoreDuplicates(db, { libraryId: w.lib.id, ids: [] })).toBe(0);
  });

  it("refuses to hide nothing, the kept photo itself, a photo that is hidden itself, or a photo from elsewhere", async () => {
    const { w, big, small, edit } = await checked();
    const other = await world();
    const stranger = await other.photo("stranger.jpg");
    expect(await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [] })).toMatchObject({ ok: false, status: 400 });
    expect(await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [big.id] })).toMatchObject({ ok: false, status: 400 });
    expect(await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [stranger.id] })).toMatchObject({ ok: false, status: 404 });
    expect(await hideDuplicates(db, { libraryId: other.lib.id, keepId: stranger.id, hideIds: [big.id] })).toMatchObject({ ok: false, status: 404 });
    await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [small.id] });
    expect(await hideDuplicates(db, { libraryId: w.lib.id, keepId: small.id, hideIds: [edit.id] })).toMatchObject({ ok: false, status: 400 });
    expect(await restoreDuplicates(db, { libraryId: other.lib.id, ids: [small.id] })).toBe(0); // another library can't restore it
  });

  it("keeps working when the kept photo is deleted: the hidden copy comes back", async () => {
    const { w, big, small } = await checked();
    await hideDuplicates(db, { libraryId: w.lib.id, keepId: big.id, hideIds: [small.id] });
    await db.delete(titles).where(eq(titles.id, big.id));
    expect((await db.select().from(titles).where(eq(titles.id, small.id)))[0].duplicateOf).toBeNull();
    expect((await listTimeline(db, { actor: w.actor, viewer: adult, libraryId: w.lib.id }))?.items.map((i) => i.id)).toContain(small.id);
  });
});
