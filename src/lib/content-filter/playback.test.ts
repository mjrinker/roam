import { describe, expect, it } from "vitest";
import type { FilterCue } from "./categories";
import { guideFromCues, playbackCues, skipsFor } from "./playback";

const cue = (start: number, end: number, category: FilterCue["category"], severity: FilterCue["severity"] = "high", channel: FilterCue["channel"] = "both"): FilterCue => ({ startSeconds: start, endSeconds: end, category, severity, channel });

describe("playbackCues", () => {
  it("puts each part's cues on one clock", () => {
    const out = playbackCues(
      [
        { startSeconds: 0, durationSeconds: 3000, cues: [cue(100, 110, "violence")] },
        { startSeconds: 3000, durationSeconds: 3000, cues: [cue(50, 60, "language", "low", "sound")] },
      ],
      6000
    );
    expect(out.map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["violence", 100, 110], ["language", 3050, 3060]]);
  });
  it("cuts a cue to a trimmed segment's window and drops those outside it", () => {
    const out = playbackCues([{ startSeconds: 0, durationSeconds: 1000, inFileOffsetSeconds: 1000, inFileEndSeconds: 2000, cues: [cue(900, 1100, "sex"), cue(1500, 1510, "fear"), cue(2500, 2600, "drugs")] }], 1000);
    expect(out.map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["sex", 0, 100], ["fear", 500, 510]]);
  });
});

describe("skipsFor", () => {
  const cues = [cue(10, 20, "violence", "low"), cue(30, 40, "violence", "high"), cue(50, 52, "language", "medium", "sound"), cue(60, 70, "nudity", "high")];
  it("includes only the chosen categories, at or above the chosen strength", () => {
    expect(skipsFor(cues, { violence: "high" }).map((s) => [s.startSeconds, s.action])).toEqual([[30, "skip"]]);
    expect(skipsFor(cues, { violence: "low" }).map((s) => s.startSeconds)).toEqual([10, 30]);
    expect(skipsFor(cues, {})).toEqual([]);
  });
  it("mutes an audio-only cue instead of skipping it", () => {
    expect(skipsFor(cues, { language: "low" })).toEqual([{ startSeconds: 50, endSeconds: 52, action: "mute", categories: ["language"] }]);
  });
  it("merges stretches that overlap or touch, naming every reason, and does not mute inside a skip", () => {
    const out = skipsFor([cue(10, 20, "violence"), cue(20.5, 30, "sex"), cue(100, 110, "violence"), cue(102, 104, "language", "high", "sound")], { violence: "low", sex: "low", language: "low" });
    expect(out).toEqual([
      { startSeconds: 10, endSeconds: 30, action: "skip", categories: ["violence", "sex"] },
      { startSeconds: 100, endSeconds: 110, action: "skip", categories: ["violence"] },
    ]);
  });
});

describe("guideFromCues", () => {
  it("gives the strongest level, the scenes and their length per category, in the usual order", () => {
    const out = guideFromCues([cue(10, 20, "language", "low"), cue(10, 20, "language", "medium"), cue(30, 35, "violence", "high"), cue(50, 52, "violence", "low")]);
    expect(out).toEqual([
      { category: "violence", severity: "high", scenes: 2, seconds: 7 },
      { category: "language", severity: "medium", scenes: 1, seconds: 20 },
    ]);
  });
  it("is empty without cues", () => {
    expect(guideFromCues([])).toEqual([]);
  });
});
