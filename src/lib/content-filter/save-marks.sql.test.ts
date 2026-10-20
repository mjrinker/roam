/** Hand-marked scenes through the database: saved as a file beside each video where Roam can write, in the database where it can't. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { FilterCue } from "./categories";
import { parseMcf } from "./mcf";
import { loadMarks, saveMarks, type MarkWriter } from "./save-marks";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function film(parts: { duration: number; boxFileId?: string; cues?: FilterCue[] }[]) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:m${++n}` });
  const ids: string[] = [];
  for (const [i, p] of parts.entries()) {
    const [r] = await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: i, boxFileId: p.boxFileId ?? `mbox${n}-${i}`, filename: `Movie - pt${i + 1}.mp4`, sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: p.duration, contentCues: p.cues ?? null }).returning({ id: mediaFiles.id });
    ids.push(r.id);
  }
  return { t, server, ids };
}
const cue = (s: number, e: number, category: FilterCue["category"] = "violence"): FilterCue => ({ startSeconds: s, endSeconds: e, category, severity: "high", channel: "both" });
const rowOf = async (id: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.id, id)))[0];

function writer(writable: boolean) {
  const written: { name: string; text: string; fileId: string }[] = [];
  const w: MarkWriter & { written: typeof written; failWith?: Error } = {
    written,
    writable: async () => writable,
    write: async (_server, row, name, text) => {
      if (w.failWith) throw w.failWith;
      written.push({ name, text, fileId: row.boxFileId });
    },
  };
  return w;
}
const args = (f: Awaited<ReturnType<typeof film>>, w: MarkWriter, cues: unknown, version: string | null = "") => ({ serverId: f.server.id, ownerKind: "title" as const, ownerId: f.t.id, version, cues, writer: w });

describe("where Roam can write a file (Box)", () => {
  it("writes a scene file beside each part, named for the video, and updates the database at once", async () => {
    const f = await film([{ duration: 60 }, { duration: 100 }]);
    const w = writer(true);
    const r = await saveMarks(db, args(f, w, [{ startSeconds: 50, endSeconds: 70, category: "violence", severity: "high" }, { startSeconds: 80, endSeconds: 85, category: "language", severity: "low", channel: "sound" }]));
    expect(r.ok && r.filesWritten).toBe(2);
    expect(w.written.map((x) => x.name)).toEqual(["Movie - pt1.mcf", "Movie - pt2.mcf"]);
    expect(parseMcf(w.written[0].text).map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["violence", 50, 60]]);
    expect(parseMcf(w.written[1].text).map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["violence", 0, 10], ["language", 20, 25]]);
    expect((await rowOf(f.ids[1])).contentCues).toHaveLength(2);
    expect((await rowOf(f.ids[0])).markedCues).toBeNull(); // the file is the truth: nothing is kept twice
    const back = await loadMarks(db, "title", f.t.id, "", w);
    expect(back?.writesFiles).toBe(true);
    expect(back?.editable.map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["violence", 50, 60], ["violence", 60, 70], ["language", 80, 85]]);
  });
  it("edits what a scene file already had, and does not rewrite files that didn't change", async () => {
    const f = await film([{ duration: 60, cues: [cue(10, 20)] }, { duration: 100, cues: [cue(5, 6)] }]);
    const w = writer(true);
    const cur = await loadMarks(db, "title", f.t.id, "", w);
    expect(cur?.editable).toHaveLength(2);
    const r = await saveMarks(db, args(f, w, [{ ...cur!.editable[0] }])); // the second part's scene is deleted
    expect(r.ok && r.filesWritten).toBe(1);
    expect(w.written.map((x) => x.name)).toEqual(["Movie - pt2.mcf"]);
    expect((await rowOf(f.ids[1])).contentCues).toBeNull();
    expect((await rowOf(f.ids[0])).contentCues).toEqual([cue(10, 20)]);
  });
  it("leaves the database alone, and says so, when the file can't be written", async () => {
    const f = await film([{ duration: 60, cues: [cue(10, 20)] }]);
    const w = writer(true);
    w.failWith = new Error("Box said no");
    await expect(saveMarks(db, args(f, w, []))).rejects.toThrow("Box said no");
    expect((await rowOf(f.ids[0])).contentCues).toEqual([cue(10, 20)]);
  });
});

describe("where Roam can't write a file", () => {
  it("keeps the marks in the database, shows the file's own as read-only, and writes nothing", async () => {
    const f = await film([{ duration: 100, cues: [cue(1, 2)] }]);
    const w = writer(false);
    const r = await saveMarks(db, args(f, w, [{ startSeconds: 30, endSeconds: 40, category: "sex", severity: "medium" }]));
    expect(w.written).toEqual([]);
    expect(r.ok && r.marks.writesFiles).toBe(false);
    expect(r.ok && r.marks.editable.map((c) => c.category)).toEqual(["sex"]);
    expect(r.ok && r.marks.readOnly).toEqual([cue(1, 2)]);
    expect((await rowOf(f.ids[0])).markedCues).toHaveLength(1);
    expect((await rowOf(f.ids[0])).contentCues).toEqual([cue(1, 2)]); // the file's scenes are untouched
  });
});

describe("what is refused", () => {
  it("is not ready until every part's length is known, and drops marks outside the film", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "movies", "everyone");
    const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:m${++n}` });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `nr${n}`, filename: "x.mp4", sizeBytes: 1, container: "mp4", probeStatus: "pending" });
    const w = writer(true);
    expect(await saveMarks(db, { serverId: server.id, ownerKind: "title", ownerId: t.id, version: "", cues: [], writer: w })).toEqual({ ok: false, error: "not_ready" });
    const f = await film([{ duration: 100 }]);
    const r = await saveMarks(db, args(f, w, [{ startSeconds: 500, endSeconds: 600, category: "sex", severity: "low" }, { startSeconds: 1, endSeconds: 2, category: "animals", severity: "low" }]));
    expect(r.ok && r.marks.editable).toEqual([]);
  });
});
