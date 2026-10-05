/**
 * Removing videos that left Box: every guard, on a real in-memory Postgres. The pruner is the one place
 * that deletes watch history and playlist entries, so most of these tests are about when it must NOT act.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: {} as Record<string, import("@/lib/storage/provider").StorageEntry[]>,
  gone: new Set<string>(),
  failList: new Set<string>(),
  existsCalls: [] as string[],
}));

vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return { ...original, probeFiles: vi.fn(async () => false), probeCodecsForPending: vi.fn(async () => undefined) };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    listFolder: async (id: string) => {
      if (h.failList.has(id)) throw new Error("Box: 503");
      return h.tree[id] ?? [];
    },
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "x", expiresAt: new Date() }),
    fetchByteRange: async () => new ArrayBuffer(0),
    fileExists: async (id: string) => {
      h.existsCalls.push(id);
      return !h.gone.has(id);
    },
  }),
}));

import { artworkImages, libraries, mediaFiles, playlistItems, titleArtwork, titles, watchState } from "@/lib/db/schema";
import { addItem, makeAccount, makeLibrary, makePlaylist, makeServer, putArtwork, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { scanLibrary } from "./scanner";
import { syncVideoDirectory } from "./video-library";
import { markCycleUnclean, PRUNE_MAX_ABSOLUTE, PRUNE_VERIFY_MAX, pruneMissingVideos, pruneNote, pruneSettings, tooManyToRemove } from "./video-prune";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
  pruneSettings.graceMs = 0; // most tests are about WHICH videos go; the grace period has its own tests below
});

let n = 0;
const file = (name: string, id: string): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1000 });
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" });
const FAR = () => Date.now() + 60_000;
const titlesOf = (libraryId: string) => db.select().from(titles).where(eq(titles.libraryId, libraryId));

/** A video library mid-cycle: a cycle id, clean, and videos "seen" (stamped) or not. */
async function world(opts: { clean?: boolean } = {}) {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "video", "everyone");
  const cycle = crypto.randomUUID();
  await db.update(libraries).set({ scanCycleId: cycle, scanCycleClean: opts.clean ?? true }).where(eq(libraries.id, lib.id));
  const prefix = `pr${++n}-`;
  const add = async (name: string, seen: boolean) => {
    const id = `${prefix}${name}`;
    await syncVideoDirectory(lib.id, "p", "", [file(`${name}.mp4`, id)], cycle);
    // "Not seen this cycle" = last seen in an earlier one.
    if (!seen) await db.update(titles).set({ lastSeenCycle: crypto.randomUUID() }).where(eq(titles.boxFolderId, `file:${id}`));
    return { id, key: `file:${id}` };
  };
  return { admin, server, lib, cycle, add, id: (name: string) => `${prefix}${name}` };
}

describe("tooManyToRemove / pruneNote", () => {
  it("lets small removals through and stops large, proportionally huge, or total ones", () => {
    expect(tooManyToRemove(2, 5)).toBe(false);
    expect(tooManyToRemove(4, 5)).toBe(false); // most of a tiny library is fine
    expect(tooManyToRemove(5, 5)).toBe(true); // ...but never the whole of one that isn't tiny
    expect(tooManyToRemove(1, 1)).toBe(false); // a one-video library may lose its one video
    expect(tooManyToRemove(20, 30)).toBe(false); // at the floor
    expect(tooManyToRemove(21, 30)).toBe(true); // above the floor and over 20%
    expect(tooManyToRemove(21, 1000)).toBe(false); // above the floor but a small share
    expect(tooManyToRemove(PRUNE_MAX_ABSOLUTE, 100_000)).toBe(false);
    expect(tooManyToRemove(PRUNE_MAX_ABSOLUTE + 1, 100_000)).toBe(true);
  });

  it("words what happened", () => {
    const base = { removed: 0, candidates: 0, unverified: 0, waiting: 0, skipped: null } as const;
    expect(pruneNote(base)).toBeNull();
    expect(pruneNote({ ...base, removed: 1, candidates: 1 })).toBe("Removed 1 video that is no longer in Box.");
    expect(pruneNote({ ...base, removed: 3, candidates: 5, unverified: 2 })).toBe("Removed 3 videos that are no longer in Box. 2 videos couldn't be checked against Box and were kept.");
    expect(pruneNote({ ...base, candidates: 40, skipped: "too_many" })).toContain("none were removed");
    expect(pruneNote({ ...base, skipped: "not_clean" })).toBeNull();
    expect(pruneNote({ ...base, waiting: 2 })).toBe("2 videos are no longer in Box; they will be removed from Roam if they stay gone for 3 days.".replace("3 days", `${Math.round(pruneSettings.graceMs / 86_400_000)} days`));
  });
});

describe("pruneMissingVideos", () => {
  const provider = { fileExists: async (id: string) => (h.existsCalls.push(id), !h.gone.has(id)) };
  const reset = () => {
    h.gone.clear();
    h.failList.clear();
    h.existsCalls.length = 0;
  };

  it("removes videos Box says are gone, with everything that hangs off them, and nothing else", async () => {
    reset();
    const w = await world();
    const seen = await w.add("seen", true);
    const moved = await w.add("moved", false); // not seen this cycle, but Box still has it (moved into an already-visited folder)
    const deleted = await w.add("deleted", false);
    const trashed = await w.add("trashed", false);
    h.gone.add(w.id("deleted"));
    h.gone.add(w.id("trashed"));

    // Everything that should go with a removed video.
    const [deletedTitle] = await db.select().from(titles).where(eq(titles.boxFolderId, deleted.key));
    const [primary] = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, deletedTitle.id));
    await db.insert(mediaFiles).values({ ownerKind: null, ownerId: null, boxFileId: "variant-of-deleted", filename: "deleted.aac.mp4", variantOfMediaFileId: primary.id });
    const sharedHash = await putArtwork(db, deletedTitle.id, [0xff, 0xd8, 0xff, 1]);
    const ownHash = await putArtwork(db, (await db.select().from(titles).where(eq(titles.boxFolderId, trashed.key)))[0].id, [0xff, 0xd8, 0xff, 2]);
    const viewer = w.admin.viewer;
    await db.insert(watchState).values({ viewerId: viewer.id, ownerKind: "title", ownerId: deletedTitle.id, positionSeconds: 10, durationSeconds: 100 });
    const playlist = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: viewer.id });
    await addItem(db, playlist.id, { titleId: deletedTitle.id });
    // And things that must survive: the seen video's own history and playlist spot.
    const [seenTitle] = await db.select().from(titles).where(eq(titles.boxFolderId, seen.key));
    await putArtwork(db, seenTitle.id, [0xff, 0xd8, 0xff, 1]); // the same picture as the removed video: it must stay
    await db.insert(watchState).values({ viewerId: viewer.id, ownerKind: "title", ownerId: seenTitle.id, positionSeconds: 5, durationSeconds: 50 });
    await addItem(db, playlist.id, { titleId: seenTitle.id }, 2048);

    const r = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
    expect(r).toMatchObject({ removed: 2, candidates: 3, unverified: 0, skipped: null });
    expect((await titlesOf(w.lib.id)).map((t) => t.boxFolderId).sort()).toEqual([moved.key, seen.key].sort());
    expect(h.existsCalls.sort()).toEqual([w.id("deleted"), w.id("moved"), w.id("trashed")].sort()); // the seen video was never even asked about

    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.boxFileId, "variant-of-deleted"))).toHaveLength(0);
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, deletedTitle.id))).toHaveLength(0);
    expect(await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, deletedTitle.id))).toHaveLength(0);
    // A picture only the removed videos used goes with them; one a surviving title shares stays.
    const images = (await db.select().from(artworkImages)).map((i) => i.hash);
    expect(images).toContain(sharedHash);
    expect(images).not.toContain(ownHash);
    expect(await db.select().from(watchState).where(and(eq(watchState.ownerId, deletedTitle.id)))).toHaveLength(0);
    expect(await db.select().from(playlistItems).where(eq(playlistItems.titleId, deletedTitle.id))).toHaveLength(0);
    // Survivors keep their data.
    expect(await db.select().from(watchState).where(eq(watchState.ownerId, seenTitle.id))).toHaveLength(1);
    expect(await db.select().from(playlistItems).where(eq(playlistItems.titleId, seenTitle.id))).toHaveLength(1);
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, seenTitle.id))).toHaveLength(1);
  });

  it("does nothing, and asks Box nothing, for an unclean cycle", async () => {
    reset();
    const w = await world({ clean: false });
    await w.add("gone", false);
    h.gone.add(w.id("gone"));
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "not_clean" });
    expect(h.existsCalls).toHaveLength(0);
    expect(await titlesOf(w.lib.id)).toHaveLength(1);
  });

  it("marking a cycle unclean stops it, but only for that cycle", async () => {
    reset();
    const w = await world();
    await w.add("gone", false);
    h.gone.add(w.id("gone"));
    await markCycleUnclean(w.lib.id, crypto.randomUUID()); // some other cycle's id: no effect on this one
    const [still] = await db.select().from(libraries).where(eq(libraries.id, w.lib.id));
    expect(still.scanCycleClean).toBe(true);
    await markCycleUnclean(w.lib.id, w.cycle);
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "not_clean" });
    await markCycleUnclean(w.lib.id, null); // no cycle at all: harmless
  });

  it("only one pass can prune a cycle, and a pass from another cycle can't", async () => {
    reset();
    const w = await world();
    await w.add("gone", false);
    h.gone.add(w.id("gone"));
    expect(await pruneMissingVideos(provider, w.lib.id, crypto.randomUUID(), FAR())).toMatchObject({ skipped: "not_clean" });
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 1 });
    const again = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
    expect(again).toMatchObject({ removed: 0, skipped: "not_clean" }); // the first one claimed it
  });

  it("removes nothing when an alarming number of videos look gone (a wrong folder, an outage)", async () => {
    reset();
    const w = await world();
    for (let i = 0; i < 30; i++) await w.add(`v${i}`, i < 5); // 25 of 30 unseen: far over a fifth, above the floor
    for (let i = 5; i < 30; i++) h.gone.add(w.id(`v${i}`));
    const r = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
    expect(r).toMatchObject({ removed: 0, candidates: 25, skipped: "too_many" }); // 25 confirmed gone: over a fifth and above the floor
    expect(await titlesOf(w.lib.id)).toHaveLength(30);
  });

  it("a reorganisation that leaves every video in Box is not an alarm: nothing is removed, and the cap isn't what stopped it", async () => {
    reset();
    const w = await world();
    for (let i = 0; i < 30; i++) await w.add(`m${i}`, false); // all unseen, all still in Box (moved around)
    const r = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
    expect(r).toMatchObject({ removed: 0, candidates: 30, skipped: null });
    expect(await titlesOf(w.lib.id)).toHaveLength(30);
  });

  it("never empties a whole library of any size in one go (that looks like a wrong folder or an outage)", async () => {
    reset();
    const w = await world();
    for (let i = 0; i < 6; i++) {
      await w.add(`all${i}`, false);
      h.gone.add(w.id(`all${i}`));
    }
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "too_many" });
    expect(await titlesOf(w.lib.id)).toHaveLength(6);
  });

  it("leaves a cycle with too many candidates to verify alone", async () => {
    reset();
    const w = await world();
    const rows = Array.from({ length: PRUNE_VERIFY_MAX + 1 }, (_, i) => ({ id: crypto.randomUUID(), libraryId: w.lib.id, kind: "movie" as const, name: `n${i}`, boxFolderId: `file:big${n}-${i}`, lastSeenCycle: crypto.randomUUID() }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(titles).values(rows.slice(i, i + 500));
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "too_many" });
    expect(h.existsCalls).toHaveLength(0);
  });

  it("keeps any video Box couldn't answer about, and removes the ones it could", async () => {
    reset();
    const w = await world();
    await w.add("gone", false);
    await w.add("unknown", false);
    h.gone.add(w.id("gone"));
    const flaky = { fileExists: async (id: string) => { if (id === w.id("unknown")) throw new Error("Box: 503"); return !h.gone.has(id); } };
    const r = await pruneMissingVideos(flaky, w.lib.id, w.cycle, FAR());
    expect(r).toMatchObject({ removed: 1, unverified: 1 });
    expect((await titlesOf(w.lib.id)).map((t) => t.boxFolderId)).toEqual([`file:${w.id("unknown")}`]);
  });

  it("stops asking when time runs out, removing only what it verified", async () => {
    reset();
    const w = await world();
    await w.add("a", false);
    await w.add("b", false);
    h.gone.add(w.id("a"));
    h.gone.add(w.id("b"));
    const r = await pruneMissingVideos(provider, w.lib.id, w.cycle, Date.now() - 1);
    expect(r).toMatchObject({ removed: 0, unverified: 2 });
    expect(await titlesOf(w.lib.id)).toHaveLength(2);
  });

  it("never acts without a way to verify, and leaves the cycle clean", async () => {
    reset();
    const w = await world();
    await w.add("gone", false);
    expect(await pruneMissingVideos({}, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "unsupported" });
    expect((await db.select().from(libraries).where(eq(libraries.id, w.lib.id)))[0].scanCycleClean).toBe(true);
  });

  it("a lost Box connection stops the prune instead of being treated as 'gone'", async () => {
    reset();
    const w = await world();
    await w.add("a", false);
    const reauth = Object.assign(new Error("reconnect"), { name: "BoxReauthRequiredError" });
    const { BoxReauthRequiredError } = await import("@/lib/storage/box-token-storage");
    const lost = { fileExists: async () => { throw new BoxReauthRequiredError("s"); } };
    void reauth;
    await expect(pruneMissingVideos(lost, w.lib.id, w.cycle, FAR())).rejects.toBeInstanceOf(BoxReauthRequiredError);
    expect(await titlesOf(w.lib.id)).toHaveLength(1);
  });

  it("stops at once if cleanup is switched off after the pass began", async () => {
    reset();
    const w = await world();
    await w.add("gone", false);
    h.gone.add(w.id("gone"));
    await db.update(libraries).set({ pruneMissing: false }).where(eq(libraries.id, w.lib.id));
    expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, skipped: "not_clean" });
    expect(await titlesOf(w.lib.id)).toHaveLength(1);
  });

  describe("grace period", () => {
    const DAY = 86_400_000;
    it("only notes a missing video the first time, removes it once it has stayed gone past the grace, and forgives one that returns", async () => {
      reset();
      pruneSettings.graceMs = 3 * DAY;
      try {
        const w = await world();
        await w.add("old", false);
        await w.add("back", false);
        await w.add("keep1", true);
        await w.add("keep2", true);
        h.gone.add(w.id("old"));
        h.gone.add(w.id("back"));
        const missingOf = async (name: string) => (await db.select().from(titles).where(eq(titles.boxFolderId, `file:${w.id(name)}`)))[0]?.missingSince ?? null;

        // First cycle: both noted, neither removed.
        const first = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
        expect(first).toMatchObject({ removed: 0, waiting: 2 });
        expect(await missingOf("old")).not.toBeNull();
        expect(await titlesOf(w.lib.id)).toHaveLength(4);

        // The next cycle comes a little later: still within the grace.
        await db.update(libraries).set({ scanCycleClean: true }).where(eq(libraries.id, w.lib.id));
        expect(await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR())).toMatchObject({ removed: 0, waiting: 2 });

        // "back" turns up again in Box (restored from the trash); "old" has been missing for four days.
        h.gone.delete(w.id("back"));
        await db.update(titles).set({ missingSince: new Date(Date.now() - 4 * DAY) }).where(eq(titles.boxFolderId, `file:${w.id("old")}`));
        await db.update(libraries).set({ scanCycleClean: true }).where(eq(libraries.id, w.lib.id));
        const later = await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
        expect(later).toMatchObject({ removed: 1, waiting: 0 });
        expect(await missingOf("back")).toBeNull(); // forgiven
        expect((await titlesOf(w.lib.id)).map((t) => t.boxFolderId).sort()).toEqual([`file:${w.id("back")}`, `file:${w.id("keep1")}`, `file:${w.id("keep2")}`].sort());
      } finally {
        pruneSettings.graceMs = 0;
      }
    });

    it("seeing a video in a scan clears its missing mark", async () => {
      const w = await world();
      await w.add("blip", true);
      await db.update(titles).set({ missingSince: new Date() }).where(eq(titles.boxFolderId, `file:${w.id("blip")}`));
      await syncVideoDirectory(w.lib.id, "p", "", [file("blip.mp4", w.id("blip"))], w.cycle);
      expect((await titlesOf(w.lib.id))[0].missingSince).toBeNull();
    });
  });

  it("never touches another library's videos", async () => {
    reset();
    const w = await world();
    const other = await world();
    await w.add("mine", false);
    await other.add("theirs", false);
    h.gone.add(w.id("mine"));
    h.gone.add(other.id("theirs"));
    await pruneMissingVideos(provider, w.lib.id, w.cycle, FAR());
    expect(await titlesOf(w.lib.id)).toHaveLength(0);
    expect(await titlesOf(other.lib.id)).toHaveLength(1);
  });
});

describe("a stale pass cannot write", () => {
  it("a pass from an older cycle changes nothing, and videos are stamped only with the current cycle", async () => {
    const w = await world();
    const stale = await syncVideoDirectory(w.lib.id, "p", "", [file("x.mp4", `stale${++n}`)], crypto.randomUUID());
    expect(stale).toMatchObject({ stale: true, added: 0 });
    expect(await titlesOf(w.lib.id)).toHaveLength(0);
    const current = await syncVideoDirectory(w.lib.id, "p", "", [file("y.mp4", `cur${++n}`)], w.cycle);
    expect(current.stale).toBe(false);
    expect((await titlesOf(w.lib.id))[0].lastSeenCycle).toBe(w.cycle);
  });
});

describe("pruning inside real scans", () => {
  async function library(over: Partial<typeof libraries.$inferInsert> = {}) {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    if (Object.keys(over).length) await db.update(libraries).set(over).where(eq(libraries.id, lib.id));
    const p = `scan${++n}-`;
    return { lib, admin, p };
  }
  const setTree = (rootId: string, p: string, files: string[]) => {
    h.gone.clear();
    h.failList.clear();
    h.tree = {
      [rootId]: [file(`${p}root.mp4`, `${p}root`), folder(`${p}dir`, "Dir")],
      [`${p}dir`]: files.map((f) => file(`${f}.mp4`, `${p}${f}`)),
    };
  };

  it("removes a video that left Box on the next full scan, along with its history", async () => {
    const { lib, admin, p } = await library();
    setTree(lib.boxFolderId, p, ["a", "b", "c"]);
    expect((await scanLibrary(lib.id, "manual")).errors).toEqual([]);
    expect(await titlesOf(lib.id)).toHaveLength(4);
    const [bTitle] = await db.select().from(titles).where(eq(titles.boxFolderId, `file:${p}b`));
    await db.insert(watchState).values({ viewerId: admin.viewer.id, ownerKind: "title", ownerId: bTitle.id, positionSeconds: 9, durationSeconds: 99 });

    // b is deleted from Box (gone from the listing AND the existence check).
    setTree(lib.boxFolderId, p, ["a", "c"]);
    h.gone.add(`${p}b`);
    const second = await scanLibrary(lib.id, "manual");
    expect(second.errors).toEqual(["Removed 1 video that is no longer in Box."]);
    expect((await titlesOf(lib.id)).map((t) => t.boxFolderId).sort()).toEqual([`file:${p}a`, `file:${p}c`, `file:${p}root`]);
    expect(await db.select().from(watchState).where(eq(watchState.ownerId, bTitle.id))).toHaveLength(0);
  });

  it("keeps a video that is still in Box but wasn't listed this time (moved while the scan ran)", async () => {
    const { lib, p } = await library();
    setTree(lib.boxFolderId, p, ["a", "b"]);
    await scanLibrary(lib.id, "manual");
    setTree(lib.boxFolderId, p, ["a"]); // b isn't in any listing...
    const second = await scanLibrary(lib.id, "manual"); // ...but Box still says it exists
    expect(second.errors).toEqual([]);
    expect(await titlesOf(lib.id)).toHaveLength(3);
  });

  it("removes nothing from a cycle in which a folder couldn't be read, then catches up once a scan is clean", async () => {
    const { lib, p } = await library();
    setTree(lib.boxFolderId, p, ["a", "b"]);
    await scanLibrary(lib.id, "manual");
    // b is really gone, but the folder holding everything can't be listed this time.
    setTree(lib.boxFolderId, p, ["a"]);
    h.gone.add(`${p}b`);
    h.failList.add(`${p}dir`);
    const broken = await scanLibrary(lib.id, "manual");
    expect(broken.errors.join(" ")).toMatch(/couldn't be read/);
    expect(broken.errors.join(" ")).not.toMatch(/Removed/);
    expect(await titlesOf(lib.id)).toHaveLength(3); // nothing removed on a cycle that missed a folder

    h.failList.clear();
    const clean = await scanLibrary(lib.id, "manual");
    expect(clean.errors).toEqual(["Removed 1 video that is no longer in Box."]);
    expect((await titlesOf(lib.id)).map((t) => t.boxFolderId).sort()).toEqual([`file:${p}a`, `file:${p}root`]);
  });

  it("does nothing when the library's cleanup is switched off", async () => {
    const { lib, p } = await library({ pruneMissing: false });
    setTree(lib.boxFolderId, p, ["a", "b"]);
    await scanLibrary(lib.id, "manual");
    setTree(lib.boxFolderId, p, ["a"]);
    h.gone.add(`${p}b`);
    expect((await scanLibrary(lib.id, "manual")).errors).toEqual([]);
    expect(await titlesOf(lib.id)).toHaveLength(3);
  });

  it("a brand-new library's first scan has nothing to remove, and starts a cycle", async () => {
    const { lib, p } = await library();
    setTree(lib.boxFolderId, p, ["a"]);
    const first = await scanLibrary(lib.id, "manual");
    expect(first.errors).toEqual([]);
    const [row] = await db.select().from(libraries).where(eq(libraries.id, lib.id));
    expect(row.scanCycleId).not.toBeNull();
    // Every video seen was stamped with that cycle.
    expect((await titlesOf(lib.id)).every((t) => t.lastSeenCycle === row.scanCycleId)).toBe(true);
  });
});
