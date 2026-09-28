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

  it("plays a combined file's group whole when one of its owners is itself split across multiple physical files", async () => {
    // ep-5 owns TWO media_files rows: this combined file (box-1, shared
    // with ep-6) and a second physical part (box-2) that belongs to ep-5
    // alone — a multi-part episode ON TOP of a multi-episode file, which
    // planFileTrims deliberately doesn't try to trim.
    mediaRows = [
      row({ id: "row-5a", ownerId: "ep-5", boxFileId: "box-1", durationSeconds: 2640, durationMs: 2640000 }),
      row({
        id: "row-5b",
        ownerId: "ep-5",
        boxFileId: "box-2",
        filename: "Show - S01E05 - pt2.mp4",
        durationSeconds: 100,
        durationMs: 100000,
        trimSource: "auto", // a leftover value makes it a "candidate" too, so its own group gets re-evaluated
      }),
      row({ id: "row-6", ownerId: "ep-6", boxFileId: "box-1", durationSeconds: 2640, durationMs: 2640000 }),
    ];
    episodeRows = [
      { id: "ep-5", number: 5, runtimeSeconds: 1320 },
      { id: "ep-6", number: 6, runtimeSeconds: 1320 },
    ];
    await resolveEpisodeSplits(["ep-5", "ep-6"]);

    const byId = new Map(updates.map((u) => [u.id, u.set]));
    // box-1's group (the real combined file): whole, because ep-5 has a
    // second row elsewhere.
    expect(byId.get("row-5a")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" });
    expect(byId.get("row-6")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" });
    // box-2's own (single-owner, single-episode) group: reset, since its
    // own filename never parsed to 2+ episodes in the first place.
    expect(byId.get("row-5b")).toEqual({ trimStartSeconds: null, trimDurationSeconds: null, trimSource: null });
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
