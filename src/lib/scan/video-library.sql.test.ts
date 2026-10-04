/**
 * Scanning a video library on a real in-memory Postgres with a fake Box tree: titles from filenames,
 * folder paths, moves, variants, the library rating, resuming, probe isolation, and a whole scan.
 * Only Box and the probe itself are faked.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  tree: {} as Record<string, import("@/lib/storage/provider").StorageEntry[]>,
  probeCalls: [] as string[][],
}));

vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
// The real probe reads MP4 boxes from Box; record which files each pass asks to probe instead.
vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return {
    ...original,
    probeFiles: vi.fn(async (_provider: unknown, files: { filename: string }[]) => {
      h.probeCalls.push(files.map((f) => f.filename).sort());
      return false;
    }),
    probeCodecsForPending: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    listFolder: async (id: string) => h.tree[id] ?? [],
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "x", expiresAt: new Date() }),
    fetchByteRange: async () => new ArrayBuffer(0),
  }),
}));
// Video libraries must never call an external metadata service: every export of these modules throws when called.
const { forbidden } = vi.hoisted(() => ({
  forbidden: (service: string) =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        typeof name === "symbol" || name === "then" || name === "__esModule"
          ? undefined
          : () => {
              throw new Error(`${service} must not be called (${name})`);
            },
    }
  ),
}));
vi.mock("@/lib/tmdb/client", () => forbidden("TMDB"));
vi.mock("@/lib/omdb/client", () => forbidden("OMDb"));

import { libraries, mediaFiles, scanRuns, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { scanLibrary } from "./scanner";
import { normalizeFolderPath } from "@/lib/libraries/folder-browse";
import { conflictNote, libraryPath, probeVideoLibrary, syncVideoDirectory, syncVideoTopFolder, titleFromFileName, unsupportedSummary } from "./video-library";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
const file = (name: string, id = `f${++n}`): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1000 });
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" });

async function newLibrary(over: Partial<typeof libraries.$inferInsert> = {}) {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "video", "everyone");
  if (Object.keys(over).length) await db.update(libraries).set(over).where(eq(libraries.id, lib.id));
  return lib;
}
const titlesOf = (libraryId: string) => db.select().from(titles).where(eq(titles.libraryId, libraryId));

describe("titleFromFileName", () => {
  it("names a video from its filename", () => {
    expect(titleFromFileName("Beach Day.mp4")).toEqual({ name: "Beach Day", year: null });
    expect(titleFromFileName("Beach Day (2019).mp4")).toEqual({ name: "Beach Day", year: 2019 });
    expect(titleFromFileName("my_vacation_2019.mov")).toEqual({ name: "my vacation 2019", year: null });
    expect(titleFromFileName("Clip.final.v2.m4v")).toEqual({ name: "Clip final v2", year: null });
    expect(titleFromFileName("  spaced   out  .mp4")).toEqual({ name: "spaced out", year: null });
    expect(titleFromFileName("Ends with (1066).mp4").year).toBeNull(); // not a plausible year
    expect(titleFromFileName("(2019).mp4")).toEqual({ name: "(2019)", year: null }); // nothing left once the year is removed
  });
});

describe("syncVideoDirectory", () => {
  it("creates one title per video with its folder, parent and library rating; counts what it skipped", async () => {
    const lib = await newLibrary({ ratingAges: { ANY: 13 } });
    const r = await syncVideoDirectory(lib.id, "box-folder-1", "Vacations/2019", [
      file("Beach Day (2019).mp4", "a"),
      file("Sunset.mov", "b"),
      file("clip.mkv", "c"),
      file("notes.txt", "d"),
      folder("sub", "Sub"),
    ]);
    expect(r).toEqual({ added: 2, seen: 2, unsupported: 1, conflicts: 0, stale: false });
    const rows = (await titlesOf(lib.id)).sort((x, y) => x.name.localeCompare(y.name));
    expect(rows.map((t) => [t.name, t.year, t.kind, t.boxFolderId, t.folderPath, t.parentFolderId, t.nameSource, t.ratingAges])).toEqual([
      ["Beach Day", 2019, "movie", "file:a", "Vacations/2019", "box-folder-1", "filename", { ANY: 13 }],
      ["Sunset", null, "movie", "file:b", "Vacations/2019", "box-folder-1", "filename", { ANY: 13 }],
    ]);
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, rows[0].id));
    expect(files).toMatchObject([{ ownerKind: "title", partIndex: 0, boxFileId: "a", filename: "Beach Day (2019).mp4", container: "mp4" }]);
  });

  it("is idempotent, picks up renames, and keeps a file's title when it moves to another folder", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p1", "A", [file("one.mp4", "x1"), file("two.mp4", "x2")]);
    const before = Object.fromEntries((await titlesOf(lib.id)).map((t) => [t.boxFolderId, t.id]));

    expect(await syncVideoDirectory(lib.id, "p1", "A", [file("one.mp4", "x1"), file("two.mp4", "x2")])).toMatchObject({ added: 0, seen: 2 });
    expect(await titlesOf(lib.id)).toHaveLength(2);

    // Rename x1 in place; move x2 to folder B.
    await syncVideoDirectory(lib.id, "p1", "A", [file("renamed.mp4", "x1")]);
    await syncVideoDirectory(lib.id, "p2", "B/Deeper", [file("two.mp4", "x2")]);
    const after = await titlesOf(lib.id);
    expect(after).toHaveLength(2);
    const one = after.find((t) => t.boxFolderId === "file:x1")!;
    const two = after.find((t) => t.boxFolderId === "file:x2")!;
    expect([one.id, one.name]).toEqual([before["file:x1"], "renamed"]);
    expect([two.id, two.folderPath, two.parentFolderId]).toEqual([before["file:x2"], "B/Deeper", "p2"]);
  });

  it("never overwrites a name that came from the file's own tags, and keeps probe progress", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p", "", [file("IMG_0001.mp4", "t1")]);
    const [t] = await titlesOf(lib.id);
    await db.update(titles).set({ name: "Real Title From Tags", year: 2001, nameSource: "embedded" }).where(eq(titles.id, t.id));
    await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 90 }).where(eq(mediaFiles.ownerId, t.id));

    await syncVideoDirectory(lib.id, "p", "", [file("IMG_0001.mp4", "t1")]);
    const [again] = await titlesOf(lib.id);
    expect([again.name, again.year, again.nameSource]).toEqual(["Real Title From Tags", 2001, "embedded"]);
    const [mf] = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, t.id));
    expect([mf.probeStatus, mf.durationSeconds]).toEqual(["ok", 90]);
  });

  it("links a remuxed copy to its original instead of listing it as a second video, and cleans up when it disappears", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p", "", [file("Movie.mp4", "m1"), file("Movie.aac.mp4", "m1-aac")]);
    const rows = await titlesOf(lib.id);
    expect(rows.map((t) => t.name)).toEqual(["Movie"]);
    const all = await db.select().from(mediaFiles);
    const variant = all.find((f) => f.boxFileId === "m1-aac");
    const primary = all.find((f) => f.boxFileId === "m1");
    expect(variant?.variantOfMediaFileId).toBe(primary?.id);
    expect(primary?.remuxStatus).toBe("done");

    await syncVideoDirectory(lib.id, "p", "", [file("Movie.mp4", "m1")]);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.boxFileId, "m1-aac"))).length).toBe(0);
  });

  it("never touches a title that belongs to another library (overlapping Box folders), not even its rating", async () => {
    const strict = await newLibrary({ ratingAges: { ANY: 18 } });
    const lenient = await newLibrary({ ratingAges: { ANY: 0 } });
    await syncVideoDirectory(strict.id, "p", "Adults", [file("shared.mp4", "overlap-1")]);
    const r = await syncVideoDirectory(lenient.id, "q", "Kids", [file("shared.mp4", "overlap-1"), file("own.mp4", "own-1")]);
    expect(r).toMatchObject({ added: 1, seen: 1, conflicts: 1 });
    const [original] = await titlesOf(strict.id);
    expect([original.libraryId, original.folderPath, original.parentFolderId, original.ratingAges]).toEqual([strict.id, "Adults", "p", { ANY: 18 }]);
    expect((await titlesOf(lenient.id)).map((t) => t.name)).toEqual(["own"]);
    expect(conflictNote(1)).toBe("1 file is already part of another library and was skipped.");
    expect(conflictNote(2)).toBe("2 files are already part of another library and were skipped.");
  });

  it("keeps a year read from the file's tags when a rescan's filename has none", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p", "", [file("clip.mp4", "yr1")]);
    const [t] = await titlesOf(lib.id);
    await db.update(titles).set({ year: 2001 }).where(eq(titles.id, t.id)); // as the tag pass would
    await syncVideoDirectory(lib.id, "p", "", [file("clip.mp4", "yr1")]);
    expect((await titlesOf(lib.id))[0].year).toBe(2001);
    await syncVideoDirectory(lib.id, "p", "", [file("clip (1999).mp4", "yr1")]); // a filename that does state one wins over a non-embedded year
    expect((await titlesOf(lib.id))[0].year).toBe(1999);
  });

  it("lists a remuxed copy whose original isn't there as a title of its own, since it is the only copy", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p", "", [file("Only.aac.mp4", "lonely")]);
    expect((await titlesOf(lib.id)).map((t) => t.name)).toEqual(["Only"]);
  });

  it("reads a file again when it was replaced in place (same Box id, new size), and leaves untouched files alone", async () => {
    const lib = await newLibrary();
    await syncVideoDirectory(lib.id, "p", "", [file("a.mp4", "rp1"), file("b.mp4", "rp2")]);
    const rows = await titlesOf(lib.id);
    for (const t of rows) {
      await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 90, codecProbed: true }).where(eq(mediaFiles.ownerId, t.id));
      await db.update(titles).set({ tagsAttemptedAt: new Date(), thumbAttempts: 2 }).where(eq(titles.id, t.id));
    }
    // a.mp4 is replaced (size changes); b.mp4 is merely seen again.
    await syncVideoDirectory(lib.id, "p", "", [{ ...file("a.mp4", "rp1"), sizeBytes: 5555 }, file("b.mp4", "rp2")]);
    const state = async (key: string) => {
      const [t] = await db.select().from(titles).where(eq(titles.boxFolderId, `file:${key}`));
      const [m] = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, t.id));
      return { probe: m.probeStatus, dur: m.durationSeconds, codec: m.codecProbed, tags: t.tagsAttemptedAt, thumbs: t.thumbAttempts, size: m.sizeBytes };
    };
    expect(await state("rp1")).toEqual({ probe: "pending", dur: null, codec: false, tags: null, thumbs: 0, size: 5555 });
    const b = await state("rp2");
    expect([b.probe, b.dur, b.codec, b.thumbs]).toEqual(["ok", 90, true, 2]);
    expect(b.tags).not.toBeNull();
  });

  it("handles a directory of thousands of files in a few batches", async () => {
    const lib = await newLibrary();
    const many = Array.from({ length: 1200 }, (_, i) => file(`clip ${i}.mp4`, `bulk${i}`));
    const r = await syncVideoDirectory(lib.id, "p", "Bulk", many);
    expect(r).toMatchObject({ added: 1200, seen: 1200 });
    expect(await titlesOf(lib.id)).toHaveLength(1200);
    expect((await syncVideoDirectory(lib.id, "p", "Bulk", many)).added).toBe(0);
  });

  it("writes the library's CURRENT rating even for titles that already exist", async () => {
    const lib = await newLibrary({ ratingAges: { ANY: 18 } });
    await syncVideoDirectory(lib.id, "p", "", [file("v.mp4", "r1")]);
    expect((await titlesOf(lib.id))[0].ratingAges).toEqual({ ANY: 18 });
    await db.update(libraries).set({ ratingAges: { ANY: 0 } }).where(eq(libraries.id, lib.id));
    await syncVideoDirectory(lib.id, "p", "", [file("v.mp4", "r1"), file("w.mp4", "r2")]);
    expect((await titlesOf(lib.id)).map((t) => t.ratingAges)).toEqual([{ ANY: 0 }, { ANY: 0 }]);
    // Unrated stays unrated.
    await db.update(libraries).set({ ratingAges: null }).where(eq(libraries.id, lib.id));
    await syncVideoDirectory(lib.id, "p", "", [file("v.mp4", "r1"), file("w.mp4", "r2")]);
    expect((await titlesOf(lib.id)).map((t) => t.ratingAges)).toEqual([null, null]);
  });
});

describe("odd folder names", () => {
  it("stores control characters, backslashes and dot segments safely, so the folder stays browsable", () => {
    expect(libraryPath("Trips", ["Sum\u0001mer", "a\\b", "..", "."])).toBe("Trips/Sum_mer/a_b/_/_");
    expect(libraryPath(null, ["plain"])).toBe("plain");
    expect(libraryPath("Edge Space ", [" lead"])).toBe("Edge Space / lead");
    expect(normalizeFolderPath(libraryPath("Trips", ["Sum\u0001mer", "a\\b"]))).not.toBeNull();
  });
});

describe("syncVideoTopFolder", () => {
  // Box file ids are globally unique, so every test gets its own.
  function setupTree() {
    const p = `tree${++n}-`;
    h.tree = {
      top: [file("t.mp4", `${p}tf`), folder("a", "A"), folder("b", "B")],
      a: [file("a1.mp4", `${p}af1`), folder("a2", "A2")],
      a2: [file("deep.mp4", `${p}df`)],
      b: [file("b1.mp4", `${p}bf1`)],
    };
    return folder("top", "Top");
  }
  const provider = { listFolder: async (id: string) => h.tree[id] ?? [] };

  it("walks every directory and records progress after each", async () => {
    const lib = await newLibrary();
    const top = setupTree();
    const subs: string[] = [];
    const res = await syncVideoTopFolder(provider, lib.id, top, {
      afterSub: null,
      errors: [],
      budgetExhausted: () => false,
      onUnitDone: async (sub) => (subs.push(sub), true),
    });
    expect(res).toMatchObject({ titlesAdded: 4, filesSeen: 4, finished: true, superseded: false });
    expect(subs).toEqual(["/", "/a", "/a/a2", "/b"]);
    const byPath = Object.fromEntries((await titlesOf(lib.id)).map((t) => [t.name, t.folderPath]));
    expect(byPath).toEqual({ t: "Top", a1: "Top/A", deep: "Top/A/A2", b1: "Top/B" });
  });

  it("stops when the budget runs out and a later pass resumes after the last completed directory", async () => {
    const lib = await newLibrary();
    const top = setupTree();
    let done = 0;
    let lastSub: string | null = null;
    const first = await syncVideoTopFolder(provider, lib.id, top, {
      afterSub: null,
      errors: [],
      budgetExhausted: () => done >= 2,
      onUnitDone: async (sub) => ((done += 1), (lastSub = sub), true),
    });
    expect(first.finished).toBe(false);
    expect(lastSub).toBe("/a");
    expect((await titlesOf(lib.id)).map((t) => t.name).sort()).toEqual(["a1", "t"]);

    const second = await syncVideoTopFolder(provider, lib.id, top, {
      afterSub: lastSub,
      errors: [],
      budgetExhausted: () => false,
      onUnitDone: async () => true,
    });
    expect(second).toMatchObject({ finished: true, titlesAdded: 2 });
    expect((await titlesOf(lib.id)).map((t) => t.name).sort()).toEqual(["a1", "b1", "deep", "t"]);
  });

  it("reports a subfolder that can't be read and still syncs the rest, advancing past it", async () => {
    const lib = await newLibrary();
    const p = `bad${++n}-`;
    h.tree = {
      top: [file("t.mp4", `${p}t`), folder("good", "Good"), folder("bad", "Bad"), folder("later", "Later")],
      good: [file("g.mp4", `${p}g`)],
      bad: [file("never.mp4", `${p}never`)],
      later: [file("l.mp4", `${p}l`)],
    };
    const failing = { listFolder: async (id: string) => { if (id === "bad") throw new Error("Box: 503"); return h.tree[id] ?? []; } };
    const errors: string[] = [];
    const subs: string[] = [];
    const res = await syncVideoTopFolder(failing, lib.id, folder("top", "Top"), {
      afterSub: null,
      errors,
      budgetExhausted: () => false,
      onUnitDone: async (sub) => (subs.push(sub), true),
      retryDelayMs: 0,
    });
    expect(res).toMatchObject({ finished: true, titlesAdded: 3 });
    expect((await titlesOf(lib.id)).map((t) => t.name).sort()).toEqual(["g", "l", "t"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Top/Bad");
    expect(errors[0]).toContain("tried again on the next full scan");
    expect(subs).toHaveLength(4); // the unreadable folder was stepped past like any other
  });

  it("flags the cycle before the cursor moves past a failed directory, not after the whole folder", async () => {
    const lib = await newLibrary();
    const p = `ord${++n}-`;
    h.tree = {
      top: [folder("good", "Good"), folder("bad", "Bad")],
      good: [file("g.mp4", `${p}g`)],
      bad: [file("never.mp4", `${p}never`)],
    };
    const failing = { listFolder: async (id: string) => { if (id === "bad") throw new Error("Box: 503"); return h.tree[id] ?? []; } };
    const events: string[] = [];
    await syncVideoTopFolder(failing, lib.id, folder("top", "Top"), {
      afterSub: null,
      errors: [],
      budgetExhausted: () => false,
      onUnitDone: async (sub) => (events.push(`advance ${sub}`), true),
      onError: async () => void events.push("flag unclean"),
      retryDelayMs: 0,
    });
    // Directories are visited Top, Bad, Good. Bad fails: it is flagged strictly BEFORE the cursor advances past it.
    expect(events).toEqual(["advance /", "flag unclean", "advance /bad", "advance /good"]);
  });

  it("stops without touching scan state when another scan takes over the cursor", async () => {
    const lib = await newLibrary();
    const top = setupTree();
    const res = await syncVideoTopFolder(provider, lib.id, top, {
      afterSub: null,
      errors: [],
      budgetExhausted: () => false,
      onUnitDone: async () => false,
    });
    expect(res.superseded).toBe(true);
    expect(await titlesOf(lib.id)).toHaveLength(1); // only the first directory was written
  });
});

describe("probeVideoLibrary", () => {
  it("probes only this library's pending files (variants included) and nothing from other libraries", async () => {
    const mine = await newLibrary();
    const other = await newLibrary();
    await syncVideoDirectory(mine.id, "p", "", [file("mine.mp4", "pm"), file("mine.aac.mp4", "pm-aac")]);
    await syncVideoDirectory(other.id, "p", "", [file("theirs.mp4", "po")]);
    h.probeCalls.length = 0;
    const incomplete = await probeVideoLibrary({} as never, mine.id, Date.now() + 60_000, []);
    expect(incomplete).toBe(false);
    expect(h.probeCalls.flat().sort()).toEqual(["mine.aac.mp4", "mine.mp4"]);
  });
});

describe("a whole scan of a video library", () => {
  it("fails the scan (rather than treating a silently shortened listing as the whole library) when the root can't be listed completely", async () => {
    const lib = await newLibrary();
    const { ListingTruncatedError } = await import("@/lib/storage/provider");
    const boxModule = await import("@/lib/storage/box");
    const spy = vi.spyOn(boxModule, "createBoxProviderForServer").mockReturnValueOnce({
      listFolder: async (id: string, opts?: { strict?: boolean }) => {
        if (opts?.strict) throw new ListingTruncatedError(id);
        return [file("would-be-silently-partial.mp4", "partial")];
      },
      getFolder: async () => null,
      getStreamingUrl: async () => ({ url: "x", expiresAt: new Date() }),
      fetchByteRange: async () => new ArrayBuffer(0),
    });
    const result = await scanLibrary(lib.id, "manual");
    spy.mockRestore();
    expect(result.errors.join(" ")).toMatch(/more entries than can be listed/);
    expect(await titlesOf(lib.id)).toHaveLength(0);
  });

  it("syncs root files and nested folders, tells the admin what it skipped, never calls an external service, and finishes the cycle", async () => {
    const lib = await newLibrary({ ratingAges: { ANY: 7 } });
    h.tree = {
      [lib.boxFolderId]: [file("loose.mp4", "lf"), file("skip.mkv", "sk"), folder("fa", "Family"), folder("fb", "Zoo")],
      fa: [file("party.mp4", "pf"), folder("fa2", "2020")],
      fa2: [file("cake.mov", "cf"), file("old.avi", "of")],
      fb: [file("lion.mp4", "lion")],
    };
    const result = await scanLibrary(lib.id, "manual");
    expect(result.errors).toEqual(["2 files skipped: unsupported format (Roam plays .mp4, .m4v and .mov)."]);
    expect(result.incomplete).toBe(false);

    const rows = await titlesOf(lib.id);
    expect(Object.fromEntries(rows.map((t) => [t.name, t.folderPath]))).toEqual({
      loose: "",
      party: "Family",
      cake: "Family/2020",
      lion: "Zoo",
    });
    expect(rows.every((t) => t.kind === "movie" && t.ratingAges !== null && (t.ratingAges as { ANY: number }).ANY === 7)).toBe(true);

    const [after] = await db.select().from(libraries).where(eq(libraries.id, lib.id));
    expect(after.scanCursor).toBeNull();
    expect(after.scanIncomplete).toBe(false);
    const [run] = await db.select().from(scanRuns).where(eq(scanRuns.libraryId, lib.id));
    expect(run).toMatchObject({ filesSeen: 4, titlesAdded: 4 });

    // A second scan changes nothing.
    const again = await scanLibrary(lib.id, "manual");
    expect((await titlesOf(lib.id)).length).toBe(4);
    expect(again.titlesAdded).toBe(0);
  });
});

describe("unsupportedSummary", () => {
  it("is silent for zero and pluralizes correctly", () => {
    expect(unsupportedSummary(0)).toBeNull();
    expect(unsupportedSummary(1)).toContain("1 file skipped");
    expect(unsupportedSummary(3)).toContain("3 files skipped");
  });
});

