import { describe, expect, it } from "vitest";
import type { FilterCue } from "./categories";
import { parseMcf } from "./mcf";
import { cleanMarks, liftFromRows, mcfNameFor, replaceInWindow, rowWindows, sameCues, serializeMcf, splitToRows } from "./marks";

const cue = (s: number, e: number, category: FilterCue["category"] = "violence", severity: FilterCue["severity"] = "high", channel: FilterCue["channel"] = "both", note?: string): FilterCue => ({ startSeconds: s, endSeconds: e, category, severity, channel, ...(note ? { note } : {}) });
const row = (id: string, partIndex: number, durationSeconds: number | null, trim?: [number, number]) => ({ id, partIndex, durationSeconds, trimStartSeconds: trim?.[0] ?? null, trimDurationSeconds: trim?.[1] ?? null });

describe("rowWindows", () => {
  it("lays files end to end on the film's clock, in part order", () => {
    expect(rowWindows([row("b", 1, 100), row("a", 0, 60)])).toEqual([
      { rowId: "a", fileOffset: 0, length: 60, clockStart: 0 },
      { rowId: "b", fileOffset: 0, length: 100, clockStart: 60 },
    ]);
  });
  it("uses an episode's slice of a combined file", () => {
    expect(rowWindows([row("a", 0, 5000, [1800, 1700])])).toEqual([{ rowId: "a", fileOffset: 1800, length: 1700, clockStart: 0 }]);
  });
  it("is empty until every length is known", () => {
    expect(rowWindows([row("a", 0, null)])).toEqual([]);
    expect(rowWindows([])).toEqual([]);
  });
});

describe("splitToRows and liftFromRows", () => {
  const windows = rowWindows([row("a", 0, 60), row("b", 1, 100)]);
  it("splits a scene across two parts into one cue each, in each file's own time", () => {
    const m = splitToRows([cue(50, 70, "violence", "high", "both", "x")], windows);
    expect(m.get("a")).toEqual([cue(50, 60, "violence", "high", "both", "x")]);
    expect(m.get("b")).toEqual([cue(0, 10, "violence", "high", "both", "x")]);
  });
  it("round-trips back onto the film's clock", () => {
    const original = [cue(10, 20), cue(55, 80, "sex", "low")];
    const perRow = splitToRows(original, windows);
    const back = liftFromRows(perRow, windows);
    expect(back.map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([["violence", 10, 20], ["sex", 55, 60], ["sex", 60, 80]]);
  });
  it("puts an episode's marks at the right place in a combined file", () => {
    const w = rowWindows([row("a", 0, 5000, [1800, 1700])]);
    expect(splitToRows([cue(10, 20)], w).get("a")).toEqual([cue(1810, 1820)]);
    expect(liftFromRows(new Map([["a", [cue(1810, 1820), cue(100, 110)]]]), w)).toEqual([cue(10, 20)]); // the other episode's cue is not this one's
  });
});

describe("replaceInWindow", () => {
  it("replaces what is inside the window and keeps the rest of a combined file", () => {
    const w = rowWindows([row("a", 0, 5000, [1800, 1700])])[0];
    const existing = [cue(100, 110), cue(1900, 1910), cue(4000, 4010)];
    expect(replaceInWindow(existing, w, [cue(2000, 2005, "sex")]).map((c) => c.startSeconds)).toEqual([100, 2000, 4000]);
  });
  it("starts from nothing", () => {
    const w = rowWindows([row("a", 0, 100)])[0];
    expect(replaceInWindow(null, w, [cue(1, 2)])).toEqual([cue(1, 2)]);
    expect(replaceInWindow([cue(1, 2)], w, [])).toEqual([]);
  });
  it("compares cue lists", () => {
    expect(sameCues(null, [])).toBe(true);
    expect(sameCues([cue(1, 2)], [cue(1, 2)])).toBe(true);
    expect(sameCues([cue(1, 2)], [cue(1, 3)])).toBe(false);
  });
});

describe("cleanMarks", () => {
  it("keeps good marks, rounds, caps the end at the film's length, and drops the rest", () => {
    const out = cleanMarks(
      [
        { startSeconds: 10.12345, endSeconds: 20, category: "violence", severity: "high", channel: "sound", note: "  a # b  " },
        { startSeconds: 90, endSeconds: 500, category: "sex", severity: "low" },
        { startSeconds: 5, endSeconds: 5, category: "sex", severity: "low" },
        { startSeconds: -1, endSeconds: 5, category: "sex", severity: "low" },
        { startSeconds: 1, endSeconds: 5, category: "animals", severity: "low" }, // not one of the format's categories
        { startSeconds: 1, endSeconds: 5, category: "sex", severity: "extreme" },
        { startSeconds: 200, endSeconds: 210, category: "sex", severity: "low" }, // starts after the end
        "nonsense",
      ],
      100
    );
    expect(out).toEqual([
      { startSeconds: 10.123, endSeconds: 20, category: "violence", severity: "high", channel: "sound", note: "a b" },
      { startSeconds: 90, endSeconds: 100, category: "sex", severity: "low", channel: "both" },
    ]);
    expect(cleanMarks("x", 100)).toEqual([]);
  });
});

describe("serializeMcf", () => {
  const cues = [cue(6.075, 10.5), cue(374, 377.581, "language", "medium", "sound", "bad word"), cue(374, 377.581, "drugs", "low", "picture"), cue(5000, 5010, "animals" as FilterCue["category"])];
  it("writes a file the format's reader reads back", () => {
    const text = serializeMcf(cues, { title: "A Film (2020)", type: "movie", durationSeconds: 7200 });
    expect(text.startsWith("WEBVTT MovieContentFilter 1.1.0")).toBe(true);
    expect(text).toContain("END 02:00:00.000");
    expect(text).toContain("language=medium=audio # bad word");
    expect(text).toContain("drugs=low=video");
    expect(parseMcf(text)).toEqual([cue(6.075, 10.5), cue(374, 377.581, "language", "medium", "sound", "bad word"), cue(374, 377.581, "drugs", "low", "picture")]);
  });
  it("writes a valid file with no cues", () => {
    expect(parseMcf(serializeMcf([], { title: "x", type: "episode", durationSeconds: 60 }))).toEqual([]);
  });
});

describe("mcfNameFor", () => {
  it("is the video's name without its extension, then .mcf", () => {
    expect(mcfNameFor("The Matrix (1999) - pt1.mp4")).toBe("The Matrix (1999) - pt1.mcf");
    expect(mcfNameFor("Show - S01E01.m4v")).toBe("Show - S01E01.mcf");
  });
});
