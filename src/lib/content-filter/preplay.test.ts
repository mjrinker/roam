import { describe, expect, it } from "vitest";
import type { GuideLine } from "./playback";
import { choosableLines, extraFromPicks, stricterThan, withSkipParam } from "./preplay";

const line = (category: GuideLine["category"], severity: GuideLine["severity"] = "high"): GuideLine => ({ category, severity, scenes: 2, seconds: 30 });

describe("choosableLines", () => {
  it("leaves out only the categories the profile already skips entirely", () => {
    const lines = [line("violence"), line("language"), line("sex")];
    expect(choosableLines(lines, { violence: "low", language: "high" }).map((l) => l.category)).toEqual(["language", "sex"]);
    expect(choosableLines(lines, {})).toHaveLength(3);
  });
});

describe("stricterThan", () => {
  it("offers every strength when the profile skips nothing, and only stricter ones otherwise", () => {
    expect(stricterThan(undefined)).toEqual(["low", "medium", "high"]);
    expect(stricterThan("high")).toEqual(["low", "medium"]);
    expect(stricterThan("medium")).toEqual(["low"]);
    expect(stricterThan("low")).toEqual([]);
  });
});

describe("extraFromPicks", () => {
  it("keeps only picks that skip more than the profile does", () => {
    expect(extraFromPicks({ violence: "medium", language: "high", sex: "low" }, { violence: "high", language: "medium" })).toEqual({ violence: "medium", sex: "low" });
    expect(extraFromPicks({}, { violence: "high" })).toEqual({});
  });
});

describe("withSkipParam", () => {
  it("adds the choices to an address, with or without a query", () => {
    expect(withSkipParam("/s/1/watch/title/2", "violence:high")).toBe("/s/1/watch/title/2?skip=violence:high");
    expect(withSkipParam("/s/1/watch/title/2?t=30", "violence:high")).toBe("/s/1/watch/title/2?t=30&skip=violence:high");
    expect(withSkipParam("/s/1/watch/title/2", "")).toBe("/s/1/watch/title/2");
  });
});
