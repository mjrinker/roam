import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { fingerprint, fingerprintPhases, fft, popcount, FRAME_SECONDS, SAMPLE_RATE } from "./fingerprint";
import { agree, bestShared } from "./match";
import { detectShared, referencesFor, type EpisodeAudio } from "./detect";

import { concat, music, scaled, talk, withNoise } from "./test-audio";

/** An episode: some story, the (shared) opening, more story. */
function episode(id: string, seed: number, introAt: number, intro: Float32Array, total = 240): EpisodeAudio & { introAt: number; introLen: number } {
  const introLen = intro.length / SAMPLE_RATE;
  const audio = concat(talk(seed, introAt), music(seed + 1000, 3) , intro, music(seed + 2000, 2), talk(seed + 3000, total - introAt - introLen - 5));
  return { id, fps: fingerprintPhases(audio), windowStart: 0, introAt: introAt + 3, introLen };
}

describe("the fingerprint", () => {
  it("makes one 32-bit value per quarter second and is the same for the same sound", () => {
    const a = fingerprint(music(1, 20));
    expect(a.length).toBeGreaterThan(70);
    expect(a.length).toBeLessThanOrEqual(Math.floor(20 / FRAME_SECONDS));
    expect(Array.from(fingerprint(music(1, 20)))).toEqual(Array.from(a));
    expect(fingerprint(new Float32Array(100))).toHaveLength(0);
  });
  it("agrees far more for the same music at another volume or with noise than for different music", () => {
    const base = fingerprint(music(5, 30));
    const loud = fingerprint(scaled(music(5, 30), 3));
    const noisy = fingerprint(withNoise(music(5, 30), 0.15, 9));
    const other = fingerprint(music(6, 30));
    const agreement = (x: Uint32Array, y: Uint32Array) => 1 - Array.from(x, (v, i) => popcount((v ^ y[i]) >>> 0)).reduce((n, b) => n + b, 0) / (32 * x.length);
    expect(agreement(base, loud)).toBeGreaterThan(0.95);
    expect(agreement(base, noisy)).toBeGreaterThan(0.75);
    expect(agreement(base, other)).toBeLessThan(0.62);
  });
  it("computes a Fourier transform (a pure tone lands in one bin)", () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mags = Array.from(re, (x, i) => Math.hypot(x, im[i]));
    expect(mags[5]).toBeCloseTo(n / 2, 5);
    expect(mags[n - 5]).toBeCloseTo(n / 2, 5); // a real signal's mirror image
    expect(mags.filter((m, i) => i !== 5 && i !== n - 5).every((m) => m < 1e-6)).toBe(true);
    expect(popcount(0xffffffff)).toBe(32);
    expect(popcount(0)).toBe(0);
    expect(popcount(0x80000001)).toBe(2);
  });
});

describe("the stretch two fingerprints share", () => {
  const intro = music(77, 32);
  it("is found at different places in the two, with its length", () => {
    const a = episode("a", 1, 40, intro);
    const b = episode("b", 2, 95, intro);
    const s = bestShared(a.fps[0], b.fps, { maxOffsetSeconds: 130 });
    expect(s).not.toBeNull();
    expect(Math.abs(s!.aStart - a.introAt)).toBeLessThan(1.5);
    expect(Math.abs(s!.bStart - b.introAt)).toBeLessThan(1.5);
    expect(Math.abs(s!.seconds - a.introLen)).toBeLessThan(3);
    expect(s!.agreement).toBeGreaterThan(0.8);
  });
  it("is nothing for episodes that share no music, and nothing for a shared stretch that is too short", () => {
    expect(bestShared(episode("a", 1, 40, music(1, 32)).fps[0], episode("b", 2, 60, music(2, 32)).fps, { maxOffsetSeconds: 130 })).toBeNull();
    const brief = music(88, 8);
    expect(bestShared(episode("a", 1, 40, brief).fps[0], episode("b", 2, 60, brief).fps, { maxOffsetSeconds: 130 })).toBeNull();
  });
  it("ignores offsets beyond what was asked, and copes with fingerprints of different lengths", () => {
    const a = episode("a", 1, 10, intro);
    const b = episode("b", 2, 200, intro);
    expect(bestShared(a.fps[0], b.fps, { maxOffsetSeconds: 60 })).toBeNull();
    expect(bestShared(a.fps[0], b.fps.map((f) => f.slice(0, 50)))).toBeNull();
    expect(bestShared(new Uint32Array(0), b.fps)).toBeNull();
  });
});

describe("agreeing across a season", () => {
  it("takes the biggest group, as a median, if enough comparisons back it", () => {
    expect(agree([{ start: 40, end: 70 }, { start: 40.5, end: 70.5 }, { start: 41, end: 71 }, { start: 100, end: 120 }], 4)).toEqual({ start: 40.5, end: 70.5, support: 3 });
    expect(agree([{ start: 40, end: 70 }], 4)).toBeNull(); // one comparison is not agreement
    expect(agree([{ start: 40, end: 70 }, { start: 90, end: 120 }], 2)).toBeNull();
    expect(agree([], 5)).toBeNull();
    expect(agree([{ start: 1, end: 20 }, { start: 1.5, end: 20.5 }], 20)).toBeNull(); // a few matches out of many tries is chance
  });
});

describe("a season", () => {
  const intro = music(123, 30);
  const season = (n: number) => Array.from({ length: n }, (_, i) => episode(`e${i}`, 10 + i, 20 + ((i * 37) % 120), i % 3 === 0 ? scaled(intro, 0.6) : i % 3 === 1 ? withNoise(intro, 0.1, i) : intro));

  it("finds the opening of every episode, wherever it falls, even at other volumes or with noise", { timeout: 120_000 }, () => {
    const eps = season(6);
    const found = detectShared(eps, { references: 4, maxOffsetSeconds: 130 });
    for (const e of eps) {
      const d = found.get(e.id);
      expect(d, e.id).not.toBeNull();
      expect(Math.abs(d!.startSeconds - e.introAt), `${e.id} start`).toBeLessThan(2);
      expect(Math.abs(d!.endSeconds - (e.introAt + e.introLen)), `${e.id} end`).toBeLessThan(3);
      expect(d!.support).toBeGreaterThanOrEqual(2);
    }
  });

  it("adds the place the listened-to stretch begins at, and finds nothing when episodes share no sound", { timeout: 120_000 }, () => {
    const shifted = season(4).map((e) => ({ ...e, windowStart: 600 }));
    const d = detectShared(shifted, { references: 3, maxOffsetSeconds: 130 }).get("e1");
    expect(d!.startSeconds).toBeGreaterThan(600);
    const none = Array.from({ length: 4 }, (_, i) => episode(`n${i}`, 50 + i, 30 + i * 10, music(900 + i, 30)));
    expect([...detectShared(none, { references: 3, maxOffsetSeconds: 130 }).values()].every((x) => x === null)).toBe(true);
  });

  it("needs at least three episodes", () => {
    expect([...detectShared(season(2)).values()]).toEqual([null, null]);
    expect(detectShared([]).size).toBe(0);
  });

  it("picks references spread through the season, never the episode itself", () => {
    expect(referencesFor(4, 1)).toEqual([0, 2, 3]);
    const refs = referencesFor(40, 5);
    expect(refs).toHaveLength(6);
    expect(refs).not.toContain(5);
    expect(new Set(refs).size).toBe(6);
    expect(refs[refs.length - 1]).toBeGreaterThan(25);
  });
});
