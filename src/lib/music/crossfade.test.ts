import { describe, expect, it } from "vitest";
import { clampCrossfade, fadeGains, MIN_OVERLAP_SECONDS, overlapSeconds, shouldHandOver, shouldPrepareNext, volumeIsAdjustable } from "./crossfade";

describe("the crossfade length", () => {
  it("is a whole number of seconds from 0 to 12, and anything else is off", () => {
    expect([0, 5, 12, 13, -3, 4.6].map(clampCrossfade)).toEqual([0, 5, 12, 12, 0, 5]);
    expect(["8", "", " ", "abc", null, undefined, NaN, Infinity].map(clampCrossfade)).toEqual([8, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("overlaps by the length chosen, but never more than half a song", () => {
    expect(overlapSeconds(6, 200)).toBe(6);
    expect(overlapSeconds(12, 10)).toBe(5);
    expect(overlapSeconds(0, 200)).toBe(0);
    expect(overlapSeconds(6, 0)).toBe(0);
  });
});

describe("when the next song takes over", () => {
  it("only once what is left is no more than the overlap, and not for the last instant", () => {
    const at = (remainingSeconds: number, crossfade = 6) => shouldHandOver({ crossfade, songSeconds: 200, remainingSeconds });
    expect(at(30)).toBe(false);
    expect(at(6.01)).toBe(false);
    expect(at(6)).toBe(true);
    expect(at(2)).toBe(true);
    expect(at(MIN_OVERLAP_SECONDS)).toBe(false);
    expect(at(2, 0)).toBe(false); // crossfade off: songs follow each other when one ends
  });
  it("gets the next song ready well ahead", () => {
    expect(shouldPrepareNext(120)).toBe(false);
    expect(shouldPrepareNext(25)).toBe(true);
    expect(shouldPrepareNext(3)).toBe(true);
  });
});

describe("the volumes while they overlap", () => {
  it("start with the old song at full volume and end with the new one, with the same total power throughout", () => {
    expect(fadeGains(0)).toEqual({ out: 1, in: 0 });
    const end = fadeGains(1);
    expect(end.out).toBeCloseTo(0, 10);
    expect(end.in).toBeCloseTo(1, 10);
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const g = fadeGains(p);
      expect(g.out ** 2 + g.in ** 2).toBeCloseTo(1, 10);
    }
    expect(fadeGains(-1)).toEqual({ out: 1, in: 0 });
    expect(fadeGains(2).in).toBeCloseTo(1, 10);
  });
});

describe("whether a device lets the page set the volume", () => {
  it("is yes when the volume takes, no when it stays put (an iPhone) or refuses", () => {
    expect(volumeIsAdjustable({ volume: 1 })).toBe(true);
    const fixed = { get volume() { return 1; }, set volume(_v: number) {} };
    expect(volumeIsAdjustable(fixed)).toBe(false);
    const refusing = { get volume() { return 1; }, set volume(_v: number) { throw new Error("read only"); } };
    expect(volumeIsAdjustable(refusing)).toBe(false);
  });
});
