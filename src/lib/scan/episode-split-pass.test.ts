import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { episodes, mediaFiles } from "@/lib/db/schema";

// There's no test database in this repo, so db.select/update are faked
// with canned data + a recorder, rather than executed against anything
// real. Table identity (mediaFiles vs episodes) is checked by reference,
// since both this file and episode-split-pass.ts import the same
// (unmocked) schema module.

type MediaRow = {
  id: string;
  ownerId: string;
  boxFileId: string;
  partIndex: number;
  filename: string;
  durationSeconds: number | null;
  durationMs: number | null;
  chapters: { startSeconds: number }[] | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
  trimSource: "auto" | "manual" | null;
};
type EpisodeRow = { id: string; number: number; runtimeSeconds: number | null };

let mediaRows: MediaRow[] = [];
let episodeRows: EpisodeRow[] = [];
let updates: { id: string; set: Record<string, unknown> }[] = [];

function idFromWhere(where: unknown): string {
  const { params } = new PgDialect().sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]);
  return params[0] as string;
}

vi.mock("@/lib/db/client", () => ({
  db: {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === mediaFiles) return Promise.resolve(mediaRows);
              if (table === episodes) return Promise.resolve(episodeRows);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update() {
      return {
        set(setObj: Record<string, unknown>) {
          return {
            where(where: unknown) {
              updates.push({ id: idFromWhere(where), set: setObj });
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

import { resolveEpisodeSplits } from "./episode-split-pass";

function row(overrides: Partial<MediaRow> & { id: string; ownerId: string }): MediaRow {
  return {
    boxFileId: "box-1",
    partIndex: 0,
    filename: "Show - S01E05-E06.mp4",
    durationSeconds: null,
    durationMs: null,
    chapters: null,
    trimStartSeconds: null,
    trimDurationSeconds: null,
    trimSource: null,
    ...overrides,
  };
}

describe("resolveEpisodeSplits", () => {
  beforeEach(() => {
    mediaRows = [];
    episodeRows = [];
    updates = [];
  });

  it("does nothing when there are no candidate rows", async () => {
    mediaRows = [row({ id: "row-5", ownerId: "ep-5", filename: "Show - S01E05.mp4" })];
    await resolveEpisodeSplits(["ep-5"]);
    expect(updates).toEqual([]);
  });

  it("does nothing when episodeIds is empty (no queries at all)", async () => {
    await resolveEpisodeSplits([]);
    expect(updates).toEqual([]);
  });

  it("splits a probed combined file across its two owning episodes", async () => {
    mediaRows = [
      row({ id: "row-5", ownerId: "ep-5", durationSeconds: 2640, durationMs: 2640000 }),
      row({ id: "row-6", ownerId: "ep-6", durationSeconds: 2640, durationMs: 2640000 }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);

    expect(updates).toHaveLength(2);
    const byId = new Map(updates.map((u) => [u.id, u.set]));
    expect(byId.get("row-5")).toEqual({ trimStartSeconds: 0, trimDurationSeconds: 1320, trimSource: "auto" });
    expect(byId.get("row-6")).toEqual({ trimStartSeconds: 1320, trimDurationSeconds: 1320, trimSource: "auto" });
  });

  it("does not update anything when the file isn't probed yet", async () => {
    mediaRows = [
      row({ id: "row-5", ownerId: "ep-5" }),
      row({ id: "row-6", ownerId: "ep-6" }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);
    expect(updates).toEqual([]);
  });

  it("plays whole (untrimmed) when a standalone file takes one of the combined file's episode numbers", async () => {
    // Only ep-6 owns this combined file — ep-5's number was claimed by a
    // separate standalone file instead (groupEpisodeFiles' overlap rule).
    mediaRows = [row({ id: "row-6", ownerId: "ep-6", durationSeconds: 2640, durationMs: 2640000 })];
    episodeRows = [{ id: "ep-6", number: 6, runtimeSeconds: 1320 }];
    await resolveEpisodeSplits(["ep-6"]);
    expect(updates).toEqual([
      { id: "row-6", set: { trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" } },
    ]);
  });

  it("plays a combined file's whole block whole when an owner also owns some unrelated extra file", async () => {
    // ep-5 owns TWO media_files rows: this combined file (box-1, shared
    // with ep-6) and a second, UNRELATED physical file (box-2) that
    // belongs to ep-5 alone. Since ep-5 owns both box-1 and box-2, they're
    // clustered into one group (an episode owns every part of ITS combined
    // file — see the union-find comment in episode-split-pass.ts), but
    // ep-6 doesn't have a matching second row, so the block's owner row
    // counts don't line up with its part count — not a case worth
    // reasoning about further, so the whole cluster plays untrimmed.
    mediaRows = [
      row({ id: "row-5a", ownerId: "ep-5", boxFileId: "box-1", partIndex: 0, durationSeconds: 2640, durationMs: 2640000 }),
      row({
        id: "row-5b",
        ownerId: "ep-5",
        boxFileId: "box-2",
        partIndex: 1,
        filename: "Show - S01E05 - pt2.mp4",
        durationSeconds: 100,
        durationMs: 100000,
        // A stale trim from some earlier pass — its presence (not its
        // value) is what makes this row a "candidate" too, so it's swept
        // into the cluster instead of being silently ignored.
        trimStartSeconds: 5,
        trimDurationSeconds: 80,
        trimSource: "auto",
      }),
      row({ id: "row-6", ownerId: "ep-6", boxFileId: "box-1", partIndex: 0, durationSeconds: 2640, durationMs: 2640000 }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);

    const byId = new Map(updates.map((u) => [u.id, u.set]));
    expect(byId.get("row-5a")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" });
    expect(byId.get("row-6")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" });
    expect(byId.get("row-5b")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" });
  });

  it("splits an episode's window across a part boundary when a combined file is ALSO split into physical parts", async () => {
    // A real case: a 3-episode block packed into 2 physical files.
    // Equal 1000s runtimes over a 3000s total (1500s + 1500s per part):
    // ep1 -> 0..1000 (part 1 only), ep2 -> 1000..2000 (straddles the
    // 1500s part boundary: 500s in part 1, 500s in part 2), ep3 ->
    // 2000..3000 (part 2 only).
    const filename = "Show - S01E01-E03.mp4";
    mediaRows = [
      row({ id: "e1-p1", ownerId: "ep-1", boxFileId: "part-1", partIndex: 0, filename, durationSeconds: 1500, durationMs: 1500000 }),
      row({ id: "e1-p2", ownerId: "ep-1", boxFileId: "part-2", partIndex: 1, filename, durationSeconds: 1500, durationMs: 1500000 }),
      row({ id: "e2-p1", ownerId: "ep-2", boxFileId: "part-1", partIndex: 0, filename, durationSeconds: 1500, durationMs: 1500000 }),
      row({ id: "e2-p2", ownerId: "ep-2", boxFileId: "part-2", partIndex: 1, filename, durationSeconds: 1500, durationMs: 1500000 }),
      row({ id: "e3-p1", ownerId: "ep-3", boxFileId: "part-1", partIndex: 0, filename, durationSeconds: 1500, durationMs: 1500000 }),
      row({ id: "e3-p2", ownerId: "ep-3", boxFileId: "part-2", partIndex: 1, filename, durationSeconds: 1500, durationMs: 1500000 }),
    ];
    episodeRows = [
      { id: "ep-1", number: 1, runtimeSeconds: 1000 },
      { id: "ep-2", number: 2, runtimeSeconds: 1000 },
      { id: "ep-3", number: 3, runtimeSeconds: 1000 },
    ];
    await resolveEpisodeSplits(["ep-1", "ep-2", "ep-3"]);

    const byId = new Map(updates.map((u) => [u.id, u.set]));
    // Episode 1: entirely in part 1; its part-2 row is excluded (duration 0).
    expect(byId.get("e1-p1")).toEqual({ trimStartSeconds: 0, trimDurationSeconds: 1000, trimSource: "auto" });
    expect(byId.get("e1-p2")).toEqual({ trimStartSeconds: 0, trimDurationSeconds: 0, trimSource: "auto" });
    // Episode 2: straddles the boundary — a real segment in EACH part.
    expect(byId.get("e2-p1")).toEqual({ trimStartSeconds: 1000, trimDurationSeconds: 500, trimSource: "auto" });
    expect(byId.get("e2-p2")).toEqual({ trimStartSeconds: 0, trimDurationSeconds: 500, trimSource: "auto" });
    // Episode 3: entirely in part 2; its part-1 row is excluded.
    expect(byId.get("e3-p1")).toEqual({ trimStartSeconds: 0, trimDurationSeconds: 0, trimSource: "auto" });
    expect(byId.get("e3-p2")).toEqual({ trimStartSeconds: 500, trimDurationSeconds: 1000, trimSource: "auto" });
  });

  it("resets a stale trim when the file no longer parses to 2+ episodes (renamed)", async () => {
    mediaRows = [
      row({
        id: "row-5",
        ownerId: "ep-5",
        filename: "Show - S01E05.mp4",
        trimStartSeconds: 0,
        trimDurationSeconds: 1320,
        trimSource: "auto",
      }),
    ];
    episodeRows = [{ id: "ep-5", number: 5, runtimeSeconds: 1320 }];
    await resolveEpisodeSplits(["ep-5"]);
    expect(updates).toEqual([
      { id: "row-5", set: { trimStartSeconds: null, trimDurationSeconds: null, trimSource: null } },
    ]);
  });

  it("leaves every owner of a group untouched when any one of them is manually pinned", async () => {
    mediaRows = [
      row({
        id: "row-5",
        ownerId: "ep-5",
        durationSeconds: 2640,
        durationMs: 2640000,
        trimStartSeconds: 100,
        trimDurationSeconds: 1000,
        trimSource: "manual",
      }),
      row({ id: "row-6", ownerId: "ep-6", durationSeconds: 2640, durationMs: 2640000 }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);
    expect(updates).toEqual([]);
  });

  it("does not re-write a row whose stored trim already matches the computed target", async () => {
    mediaRows = [
      row({
        id: "row-5",
        ownerId: "ep-5",
        durationSeconds: 2640,
        durationMs: 2640000,
        trimStartSeconds: 0,
        trimDurationSeconds: 1320,
        trimSource: "auto",
      }),
      row({
        id: "row-6",
        ownerId: "ep-6",
        durationSeconds: 2640,
        durationMs: 2640000,
        trimStartSeconds: 1320,
        trimDurationSeconds: 1320,
        trimSource: "auto",
      }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);
    expect(updates).toEqual([]);
  });
});
