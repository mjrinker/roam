import { describe, expect, it } from "vitest";
import { encodeSkipParam, isRemoved, mergePrefs, parseSkipParam, removedRanges, toRealTime, toViewTime, viewDuration } from "./timeline";

const skip = (startSeconds: number, endSeconds: number, action: "skip" | "mute" = "skip") => ({ startSeconds, endSeconds, action });
// Scenes cut: 100-120 (20s) and 300-330 (30s): a 1000s film is 950s without them.
const removed = removedRanges([skip(300, 330), skip(100, 120), skip(500, 505, "mute")]);

describe("removedRanges", () => {
  it("keeps only skipped scenes, sorted, with overlaps merged", () => {
    expect(removed).toEqual([{ start: 100, end: 120 }, { start: 300, end: 330 }]);
    expect(removedRanges([skip(10, 30), skip(20, 40), skip(40, 50)])).toEqual([{ start: 10, end: 50 }]);
    expect(removedRanges(null)).toEqual([]);
  });
});

describe("view time and real time", () => {
  it("shortens the film by what was cut", () => {
    expect(viewDuration(1000, removed)).toBe(950);
    expect(viewDuration(1000, [])).toBe(1000);
  });
  it("moves a time earlier by the scenes before it", () => {
    expect(toViewTime(50, removed)).toBe(50);
    expect(toViewTime(120, removed)).toBe(100);
    expect(toViewTime(200, removed)).toBe(180);
    expect(toViewTime(330, removed)).toBe(280);
    expect(toViewTime(1000, removed)).toBe(950);
  });
  it("puts a moment inside a skipped scene where the scene begins", () => {
    expect(toViewTime(110, removed)).toBe(100);
    expect(toViewTime(315, removed)).toBe(280);
    expect(isRemoved(110, removed)).toBe(true);
    expect(isRemoved(100, removed)).toBe(false);
    expect(isRemoved(200, removed)).toBe(false);
  });
  it("goes back from view time, landing after a scene when it lands on its edge", () => {
    expect(toRealTime(50, removed)).toBe(50);
    expect(toRealTime(100, removed)).toBe(120);
    expect(toRealTime(180, removed)).toBe(200);
    expect(toRealTime(280, removed)).toBe(330);
    expect(toRealTime(950, removed)).toBe(1000);
  });
  it("round-trips every time outside a skipped scene", () => {
    for (const t of [0, 1, 99.5, 120, 121, 250, 299, 330, 331, 999]) expect(toRealTime(toViewTime(t, removed), removed)).toBeCloseTo(t, 6);
  });
});

describe("choices for one play", () => {
  it("merges two sets of choices, the more cautious one winning", () => {
    expect(mergePrefs({ violence: "high", language: "low" }, { violence: "low", sex: "medium" })).toEqual({ violence: "low", language: "low", sex: "medium" });
    expect(mergePrefs({}, {})).toEqual({});
    expect(mergePrefs({ fear: "medium" }, { fear: "high" })).toEqual({ fear: "medium" });
  });
  it("carries them in the address and reads them back", () => {
    const prefs = { violence: "high" as const, nudity: "low" as const };
    expect(encodeSkipParam(prefs)).toBe("violence:high,nudity:low");
    expect(parseSkipParam(encodeSkipParam(prefs))).toEqual(prefs);
    expect(parseSkipParam(null)).toEqual({});
  });
  it("ignores what it doesn't know", () => {
    expect(parseSkipParam("violence:high,sparkles:high,sex:huge,garbage,:,fear:low")).toEqual({ violence: "high", fear: "low" });
    expect(parseSkipParam("x".repeat(5000))).toEqual({});
  });
});
