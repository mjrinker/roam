import { describe, expect, it } from "vitest";
import { computeEpisodeSplit, planFileTrims, type OwnerRow } from "./episode-split";

describe("computeEpisodeSplit", () => {
  it("splits two equal-runtime episodes evenly", () => {
    // 22 + 22 minutes = 2640s file.
    expect(computeEpisodeSplit(2640, [1320, 1320], null)).toEqual([
      { startSeconds: 0, durationSeconds: 1320 },
      { startSeconds: 1320, durationSeconds: 1320 },
    ]);
  });

  it("splits three episodes proportionally to unequal runtimes", () => {
    // 600 + 1200 + 1800 = 3600s of runtime, weights 1:2:3 over a 3600s file.
    const result = computeEpisodeSplit(3600, [600, 1200, 1800], null);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 600 },
      { startSeconds: 600, durationSeconds: 1200 },
      { startSeconds: 1800, durationSeconds: 1800 },
    ]);
  });

  it("splits evenly when runtimes are missing", () => {
    expect(computeEpisodeSplit(3000, [null, null, null], null)).toEqual([
      { startSeconds: 0, durationSeconds: 1000 },
      { startSeconds: 1000, durationSeconds: 1000 },
      { startSeconds: 2000, durationSeconds: 1000 },
    ]);
  });

  it("splits evenly if any single runtime is missing or non-positive, even if others are known", () => {
    expect(computeEpisodeSplit(2000, [1000, null], null)).toEqual([
      { startSeconds: 0, durationSeconds: 1000 },
      { startSeconds: 1000, durationSeconds: 1000 },
    ]);
    expect(computeEpisodeSplit(2000, [1000, 0], null)).toEqual([
      { startSeconds: 0, durationSeconds: 1000 },
      { startSeconds: 1000, durationSeconds: 1000 },
    ]);
  });

  it("snaps a cut to a nearby chapter", () => {
    // Raw cut at 1320; a chapter at 1350 is within the 90s window.
    const result = computeEpisodeSplit(2640, [1320, 1320], [{ startSeconds: 1350 }]);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 1350 },
      { startSeconds: 1350, durationSeconds: 1290 },
    ]);
  });

  it("does not snap to a chapter outside the snap window", () => {
    // Raw cut at 1320; a chapter at 1500 is 180s away, outside the 90s window.
    const result = computeEpisodeSplit(2640, [1320, 1320], [{ startSeconds: 1500 }]);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 1320 },
      { startSeconds: 1320, durationSeconds: 1320 },
    ]);
  });

  it("ignores chapters at or past the file's own edges", () => {
    const result = computeEpisodeSplit(2640, [1320, 1320], [{ startSeconds: 0 }, { startSeconds: 2640 }]);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 1320 },
      { startSeconds: 1320, durationSeconds: 1320 },
    ]);
  });

  it("reverts a snap that would leave a too-small window against a neighboring cut", () => {
    // 3 equal-weight episodes over 200s: raw cuts at 66.67 and 133.33. A
    // single chapter at 70 is within the 90s snap window of BOTH raw cuts,
    // so each cut independently considers snapping to it:
    //   - cut[0] (raw 66.67): accepted — 70 leaves 70s before it and
    //     63.33s before cut[1]'s raw, both >= MIN_WINDOW_SECONDS.
    //   - cut[1] (raw 133.33): rejected — snapping to the same 70 would
    //     leave only 70 - 66.67 = 3.33s against cut[0]'s raw, so it's
    //     reverted to its own raw estimate instead.
    const result = computeEpisodeSplit(200, [1, 1, 1], [{ startSeconds: 70 }]);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 70 },
      { startSeconds: 70, durationSeconds: (200 * 2) / 3 - 70 },
      { startSeconds: (200 * 2) / 3, durationSeconds: 200 - (200 * 2) / 3 },
    ]);
  });

  it("reverts a snap that would leave a too-small window against the file's start", () => {
    // 2 episodes over 200s (the minimum allowed, 2*100 > 2*60): raw cut at
    // 100. A chapter at 45 is within the 90s snap window but only 45s from
    // the file's own start — reverted.
    const result = computeEpisodeSplit(200, [1, 1], [{ startSeconds: 45 }]);
    expect(result).toEqual([
      { startSeconds: 0, durationSeconds: 100 },
      { startSeconds: 100, durationSeconds: 100 },
    ]);
  });

  it("returns null when there aren't at least two runtimes", () => {
    expect(computeEpisodeSplit(1000, [1000], null)).toBeNull();
  });

  it("returns null when the file is too short for every episode to get MIN_WINDOW_SECONDS on average", () => {
    expect(computeEpisodeSplit(119, [60, 60], null)).toBeNull();
    expect(computeEpisodeSplit(120, [60, 60], null)).toEqual([
      { startSeconds: 0, durationSeconds: 60 },
      { startSeconds: 60, durationSeconds: 60 },
    ]);
  });
});

describe("planFileTrims", () => {
  const owner = (overrides: Partial<OwnerRow> = {}): OwnerRow => ({
    episodeNumber: 5,
    ownerRowCount: 1,
    runtimeSeconds: 1320,
    trimSource: null,
    ...overrides,
  });

  it("skips when any owner is pinned to a manual trim", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, trimSource: "manual" }), owner({ episodeNumber: 6 })],
        fileSeconds: 2640,
        chapters: null,
      })
    ).toEqual({ kind: "skip" });
  });

  it("resets when the file no longer parses to 2+ episodes", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5],
        owners: [owner({ episodeNumber: 5 })],
        fileSeconds: 1320,
        chapters: null,
      })
    ).toEqual({ kind: "reset" });
  });

  it("plays whole when the owning episodes don't match the file's parsed span (the overlap case)", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 6 })], // episode 5 was claimed by a standalone file instead
        fileSeconds: 2640,
        chapters: null,
      })
    ).toEqual({ kind: "whole" });
  });

  it("plays whole when an owner is itself a multi-part combined file", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, ownerRowCount: 2 }), owner({ episodeNumber: 6 })],
        fileSeconds: 2640,
        chapters: null,
      })
    ).toEqual({ kind: "whole" });
  });

  it("skips when not yet probed", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5 }), owner({ episodeNumber: 6 })],
        fileSeconds: null,
        chapters: null,
      })
    ).toEqual({ kind: "skip" });
  });

  it("splits when everything lines up", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 6 }), owner({ episodeNumber: 5 })],
        fileSeconds: 2640,
        chapters: null,
      })
    ).toEqual({
      kind: "split",
      windows: [
        { episodeNumber: 5, startSeconds: 0, durationSeconds: 1320 },
        { episodeNumber: 6, startSeconds: 1320, durationSeconds: 1320 },
      ],
    });
  });

  it("falls back to whole when the file is too short to split meaningfully", () => {
    expect(
      planFileTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, runtimeSeconds: 30 }), owner({ episodeNumber: 6, runtimeSeconds: 30 })],
        fileSeconds: 90,
        chapters: null,
      })
    ).toEqual({ kind: "whole" });
  });
});
