import { describe, expect, it } from "vitest";
import { rowWindows } from "@/lib/content-filter/marks";
import { activeSkipButton, autoSkipNow, normalizeAutoSkip, skipKey } from "./active";
import { cleanSkipMarks, liftSkipMarks, preferOwn, replaceSkipWindow, skipMarksFromRows, splitSkipMarks } from "./marks";

const m = (kind: "intro" | "recap" | "outro" | "preview", s: number, e: number) => ({ kind, startSeconds: s, endSeconds: e });
const row = (id: string, partIndex: number, durationSeconds: number | null, trim?: [number, number]) => ({ id, partIndex, durationSeconds, trimStartSeconds: trim?.[0] ?? null, trimDurationSeconds: trim?.[1] ?? null });

describe("cleanSkipMarks", () => {
  it("keeps one of each kind (the last), rounds, stays inside the film, and drops nonsense", () => {
    const out = cleanSkipMarks([m("intro", 10.123, 40), m("intro", 20, 50), m("outro", 90, 500), m("recap", 5, 6), m("recap", -1, 30), { kind: "bogus", startSeconds: 1, endSeconds: 40 }, "x", m("preview", 200, 260)], 100);
    expect(out).toEqual([m("intro", 20, 50), m("outro", 90, 100)]);
    expect(cleanSkipMarks("nope", 100)).toEqual([]);
  });
});

describe("splitting and lifting across parts", () => {
  const windows = rowWindows([row("a", 0, 60), row("b", 1, 100)]);
  it("puts a mark in the file it is in, in that file's time, and joins one that crosses the parts back together", () => {
    const split = splitSkipMarks([m("intro", 10, 30), m("outro", 50, 75)], windows);
    expect(split.get("a")).toEqual([m("intro", 10, 30), m("outro", 50, 60)]);
    expect(split.get("b")).toEqual([m("outro", 0, 15)]);
    expect(liftSkipMarks(split, windows)).toEqual([m("intro", 10, 30), m("outro", 50, 75)]);
  });
  it("uses an episode's slice of a combined file", () => {
    const w = rowWindows([row("a", 0, 5000, [1800, 1700])]);
    expect(splitSkipMarks([m("intro", 5, 40)], w).get("a")).toEqual([m("intro", 1805, 1840)]);
    expect(liftSkipMarks(new Map([["a", [m("intro", 1805, 1840), m("intro", 100, 140)]]]), w)).toEqual([m("intro", 5, 40)]); // the other episode's is not this one's
  });
  it("replaces only what is inside the window", () => {
    const w = rowWindows([row("a", 0, 5000, [1800, 1700])])[0];
    expect(replaceSkipWindow([m("intro", 100, 140), m("intro", 1805, 1840)], w, [m("recap", 1810, 1850)])).toEqual([m("intro", 100, 140), m("recap", 1810, 1850)]);
  });
  it("reads a film's marks from its files, and none while a length is unknown", () => {
    expect(skipMarksFromRows([{ ...row("a", 0, 100), skipMarks: [m("intro", 5, 40)] }])).toEqual([m("intro", 5, 40)]);
    expect(skipMarksFromRows([{ ...row("a", 0, null), skipMarks: [m("intro", 5, 40)] }])).toEqual([]);
  });
});

describe("preferOwn", () => {
  it("uses the hand-marked time for a kind and SkipDB's only for the kinds without one", () => {
    expect(preferOwn([m("intro", 10, 50)], [m("intro", 12, 52), m("outro", 900, 960)])).toEqual([m("intro", 10, 50), m("outro", 900, 960)]);
    expect(preferOwn([], [m("intro", 12, 52)])).toEqual([m("intro", 12, 52)]);
  });
});

describe("hand-marked times and the button", () => {
  it("carries no SkipDB credit for a time marked here", () => {
    expect(activeSkipButton([{ ...m("intro", 10, 50), source: "own" as const }], 20, 1000, false)?.fromSkipdb).toBe(false);
    expect(activeSkipButton([m("intro", 10, 50)], 20, 1000, false)?.fromSkipdb).toBe(true);
  });
});

describe("auto-skip", () => {
  const segs = [m("intro", 10, 50), m("outro", 900, 960)];
  it("presses the button for a kind the profile skips by itself, once per play", () => {
    const done = new Set<string>();
    const state = activeSkipButton(segs, 20, 1000, true)!;
    expect(autoSkipNow(state, { intro: true }, done)).toBe(state);
    done.add(skipKey(state));
    expect(autoSkipNow(state, { intro: true }, done)).toBeNull();
  });
  it("leaves alone a kind the profile did not choose, and works for credits as the next episode", () => {
    expect(autoSkipNow(activeSkipButton(segs, 20, 1000, true), { recap: true, outro: false }, new Set())).toBeNull();
    expect(autoSkipNow(activeSkipButton(segs, 20, 1000, true), undefined, new Set())).toBeNull();
    expect(autoSkipNow(activeSkipButton(segs, 905, 1000, true), { outro: true }, new Set())).toMatchObject({ action: "next" });
    expect(autoSkipNow(null, { intro: true }, new Set())).toBeNull();
  });
  it("keeps only the four kinds, and only true", () => {
    expect(normalizeAutoSkip({ intro: true, recap: false, outro: "yes", preview: true, extra: true })).toEqual({ intro: true, preview: true });
    expect(normalizeAutoSkip(null)).toEqual({});
  });
});
