import { describe, expect, it } from "vitest";
import { computeEpisodeSplit, planCombinedTrims, splitWindowAcrossParts, type OwnerRow } from "./episode-split";

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

describe("planCombinedTrims", () => {
  const owner = (overrides: Partial<OwnerRow> = {}): OwnerRow => ({
    episodeNumber: 5,
    ownerRowCount: 1,
    runtimeSeconds: 1320,
    trimSource: null,
    ...overrides,
  });

  const onePart = (durationSeconds: number | null = 2640) => [
    { boxFileId: "box-1", durationSeconds, chapters: null },
  ];

  it("skips when any owner is pinned to a manual trim", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, trimSource: "manual" }), owner({ episodeNumber: 6 })],
        parts: onePart(),
      })
    ).toEqual({ kind: "skip" });
  });

  it("resets when the file no longer parses to 2+ episodes", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5],
        owners: [owner({ episodeNumber: 5 })],
        parts: onePart(1320),
      })
    ).toEqual({ kind: "reset" });
  });

  it("plays whole when the owning episodes don't match the file's parsed span (the overlap case)", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 6 })], // episode 5 was claimed by a standalone file instead
        parts: onePart(),
      })
    ).toEqual({ kind: "whole" });
  });

  it("plays whole when an owner's total row count doesn't match this file's part count (an unrelated extra file)", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, ownerRowCount: 2 }), owner({ episodeNumber: 6, ownerRowCount: 1 })],
        parts: onePart(), // only 1 part in THIS file, but episode 5 owns 2 rows total
      })
    ).toEqual({ kind: "whole" });
  });

  it("skips when not yet probed", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5 }), owner({ episodeNumber: 6 })],
        parts: onePart(null),
      })
    ).toEqual({ kind: "skip" });
  });

  it("splits when everything lines up (single physical part)", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 6 }), owner({ episodeNumber: 5 })],
        parts: onePart(),
      })
    ).toEqual({
      kind: "split",
      windows: [
        { episodeNumber: 5, boxFileId: "box-1", trimStartSeconds: 0, trimDurationSeconds: 1320 },
        { episodeNumber: 6, boxFileId: "box-1", trimStartSeconds: 1320, trimDurationSeconds: 1320 },
      ],
    });
  });

  it("falls back to whole when the file is too short to split meaningfully", () => {
    expect(
      planCombinedTrims({
        parsedEpisodes: [5, 6],
        owners: [owner({ episodeNumber: 5, runtimeSeconds: 30 }), owner({ episodeNumber: 6, runtimeSeconds: 30 })],
        parts: onePart(90),
      })
    ).toEqual({ kind: "whole" });
  });

  it("splits across a part boundary when a combined file is ALSO split into multiple physical parts", () => {
    // 6 equal-length (per TMDB runtime) episodes over a two-part file:
    // part 1 is 3000s, part 2 is 3000s, 6000s total, 1000s per episode.
    // Episodes 1-3 fall entirely in part 1; episodes 4-6 fall entirely in
    // part 2 — a clean case with no episode straddling the boundary.
    const owners = [1, 2, 3, 4, 5, 6].map((n) => owner({ episodeNumber: n, ownerRowCount: 2, runtimeSeconds: 1000 }));
    const result = planCombinedTrims({
      parsedEpisodes: [1, 2, 3, 4, 5, 6],
      owners,
      parts: [
        { boxFileId: "part-1", durationSeconds: 3000, chapters: null },
        { boxFileId: "part-2", durationSeconds: 3000, chapters: null },
      ],
    });
    expect(result.kind).toBe("split");
    if (result.kind !== "split") throw new Error("unreachable");
    expect(result.windows).toEqual([
      { episodeNumber: 1, boxFileId: "part-1", trimStartSeconds: 0, trimDurationSeconds: 1000 },
      { episodeNumber: 2, boxFileId: "part-1", trimStartSeconds: 1000, trimDurationSeconds: 1000 },
      { episodeNumber: 3, boxFileId: "part-1", trimStartSeconds: 2000, trimDurationSeconds: 1000 },
      { episodeNumber: 4, boxFileId: "part-2", trimStartSeconds: 0, trimDurationSeconds: 1000 },
      { episodeNumber: 5, boxFileId: "part-2", trimStartSeconds: 1000, trimDurationSeconds: 1000 },
      { episodeNumber: 6, boxFileId: "part-2", trimStartSeconds: 2000, trimDurationSeconds: 1000 },
    ]);
  });

  it("splits an episode across BOTH parts when its window straddles the boundary", () => {
    // Same two-part 6000s file, but 4 equal episodes of 1500s each: the
    // boundary at 3000s falls exactly between episode 2 (1500-3000) and
    // episode 3 (3000-4500) — still clean. Use uneven runtimes instead so
    // a cut genuinely lands mid-part: episode 2 runs long enough to push
    // its window past the part-1/part-2 boundary.
    const owners = [
      owner({ episodeNumber: 1, ownerRowCount: 2, runtimeSeconds: 1000 }),
      owner({ episodeNumber: 2, ownerRowCount: 2, runtimeSeconds: 2500 }), // 1000..3500, straddles the 3000s boundary
      owner({ episodeNumber: 3, ownerRowCount: 2, runtimeSeconds: 2500 }),
    ];
    const result = planCombinedTrims({
      parsedEpisodes: [1, 2, 3],
      owners,
      parts: [
        { boxFileId: "part-1", durationSeconds: 3000, chapters: null },
        { boxFileId: "part-2", durationSeconds: 3000, chapters: null },
      ],
    });
    expect(result.kind).toBe("split");
    if (result.kind !== "split") throw new Error("unreachable");
    // Episode 2's window (1000..3500) overlaps BOTH parts: 1000..3000 in
    // part-1 (2000s) and 0..500 in part-2 (500s) — two segments for one episode.
    const ep2Windows = result.windows.filter((w) => w.episodeNumber === 2);
    expect(ep2Windows).toEqual([
      { episodeNumber: 2, boxFileId: "part-1", trimStartSeconds: 1000, trimDurationSeconds: 2000 },
      { episodeNumber: 2, boxFileId: "part-2", trimStartSeconds: 0, trimDurationSeconds: 500 },
    ]);
    // Episode 1 only touches part-1; episode 3 only touches part-2.
    expect(result.windows.filter((w) => w.episodeNumber === 1)).toEqual([
      { episodeNumber: 1, boxFileId: "part-1", trimStartSeconds: 0, trimDurationSeconds: 1000 },
    ]);
    expect(result.windows.filter((w) => w.episodeNumber === 3)).toEqual([
      { episodeNumber: 3, boxFileId: "part-2", trimStartSeconds: 500, trimDurationSeconds: 2500 },
    ]);
  });

  it("offsets a later part's chapters into the combined timeline before snapping", () => {
    // Two 1500s episodes over a two-part 3000s file (part-1: 1500s, part-2:
    // 1500s) — raw cut at 1500 (exactly the part boundary already, so
    // let's use uneven parts to prove the offset math): part-1 is 1400s,
    // part-2 is 1600s, still 1500/1500 runtimes -> raw cut at 1500 lands
    // 100s into part-2. A chapter at LOCAL time 90 within part-2 (global
    // time 1400+90=1490) is within the 90s snap window of the raw cut (1500).
    const owners = [
      owner({ episodeNumber: 1, ownerRowCount: 2, runtimeSeconds: 1500 }),
      owner({ episodeNumber: 2, ownerRowCount: 2, runtimeSeconds: 1500 }),
    ];
    const result = planCombinedTrims({
      parsedEpisodes: [1, 2],
      owners,
      parts: [
        { boxFileId: "part-1", durationSeconds: 1400, chapters: null },
        { boxFileId: "part-2", durationSeconds: 1600, chapters: [{ startSeconds: 90 }] },
      ],
    });
    expect(result.kind).toBe("split");
    if (result.kind !== "split") throw new Error("unreachable");
    // The cut snapped to the chapter's GLOBAL position (1400 + 90 = 1490).
    expect(result.windows).toEqual([
      { episodeNumber: 1, boxFileId: "part-1", trimStartSeconds: 0, trimDurationSeconds: 1400 },
      { episodeNumber: 1, boxFileId: "part-2", trimStartSeconds: 0, trimDurationSeconds: 90 },
      { episodeNumber: 2, boxFileId: "part-2", trimStartSeconds: 90, trimDurationSeconds: 1510 },
    ]);
  });
});

describe("splitWindowAcrossParts", () => {
  const parts = [
    { boxFileId: "a", durationSeconds: 1000 },
    { boxFileId: "b", durationSeconds: 1000 },
    { boxFileId: "c", durationSeconds: 1000 },
  ];

  it("returns a single part when the window sits entirely inside it", () => {
    expect(splitWindowAcrossParts(parts, { startSeconds: 100, durationSeconds: 200 })).toEqual([
      { boxFileId: "a", trimStartSeconds: 100, trimDurationSeconds: 200 },
    ]);
    expect(splitWindowAcrossParts(parts, { startSeconds: 1100, durationSeconds: 200 })).toEqual([
      { boxFileId: "b", trimStartSeconds: 100, trimDurationSeconds: 200 },
    ]);
  });

  it("splits a window that spans two parts", () => {
    expect(splitWindowAcrossParts(parts, { startSeconds: 900, durationSeconds: 200 })).toEqual([
      { boxFileId: "a", trimStartSeconds: 900, trimDurationSeconds: 100 },
      { boxFileId: "b", trimStartSeconds: 0, trimDurationSeconds: 100 },
    ]);
  });

  it("splits a window that spans all three parts", () => {
    expect(splitWindowAcrossParts(parts, { startSeconds: 900, durationSeconds: 1200 })).toEqual([
      { boxFileId: "a", trimStartSeconds: 900, trimDurationSeconds: 100 },
      { boxFileId: "b", trimStartSeconds: 0, trimDurationSeconds: 1000 },
      { boxFileId: "c", trimStartSeconds: 0, trimDurationSeconds: 100 },
    ]);
  });

  it("excludes a part the window doesn't touch at all", () => {
    const result = splitWindowAcrossParts(parts, { startSeconds: 0, durationSeconds: 500 });
    expect(result.map((r) => r.boxFileId)).toEqual(["a"]);
  });

  it("handles a window landing exactly on a part boundary without an empty entry", () => {
    expect(splitWindowAcrossParts(parts, { startSeconds: 1000, durationSeconds: 500 })).toEqual([
      { boxFileId: "b", trimStartSeconds: 0, trimDurationSeconds: 500 },
    ]);
  });
});
