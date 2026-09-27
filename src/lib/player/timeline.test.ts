import { describe, expect, it } from "vitest";
import {
  chapterEnd,
  chapterIndexAt,
  clampRate,
  findSegmentAt,
  formatClock,
  isEffectivelyFinished,
} from "./timeline";

const segments = [
  { startSeconds: 0, durationSeconds: 100 },
  { startSeconds: 100, durationSeconds: 50.5 },
  { startSeconds: 150.5, durationSeconds: 200 },
];
const total = 350.5;

describe("findSegmentAt", () => {
  it("finds the segment and local offset", () => {
    expect(findSegmentAt(segments, total, 0)).toMatchObject({ index: 0, localTime: 0 });
    expect(findSegmentAt(segments, total, 99.9)).toMatchObject({ index: 0 });
    expect(findSegmentAt(segments, total, 100)).toMatchObject({ index: 1, localTime: 0 });
    expect(findSegmentAt(segments, total, 200)).toMatchObject({ index: 2 });
    expect(findSegmentAt(segments, total, 200).localTime).toBeCloseTo(49.5, 6);
  });

  it("clamps out-of-range times to the ends", () => {
    expect(findSegmentAt(segments, total, -5)).toMatchObject({ index: 0, localTime: 0 });
    const end = findSegmentAt(segments, total, 9999);
    expect(end.index).toBe(2);
    expect(end.localTime).toBeCloseTo(199.95, 6);
  });
});

describe("chapters", () => {
  const chapters = [
    { title: "One", startSeconds: 0 },
    { title: "Two", startSeconds: 120 },
    { title: "Three", startSeconds: 300 },
  ];

  it("finds the chapter playing at a time", () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 119.9)).toBe(0);
    expect(chapterIndexAt(chapters, 120)).toBe(1);
    expect(chapterIndexAt(chapters, 9999)).toBe(2);
  });

  it("returns -1 with no chapters or before the first", () => {
    expect(chapterIndexAt([], 10)).toBe(-1);
    expect(chapterIndexAt([{ title: "Late", startSeconds: 30 }], 10)).toBe(-1);
  });

  it("ends a chapter at the next one, or at the end of the book", () => {
    expect(chapterEnd(chapters, 0, 500)).toBe(120);
    expect(chapterEnd(chapters, 2, 500)).toBe(500);
  });
});

describe("formatClock", () => {
  it("formats minutes and hours", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(72000)).toBe("20:00:00");
  });
  it("floors fractions and clamps negatives", () => {
    expect(formatClock(59.9)).toBe("0:59");
    expect(formatClock(-3)).toBe("0:00");
  });
});

describe("isEffectivelyFinished", () => {
  it("uses absolute remaining time, not a percentage", () => {
    // 20 hours: 30 minutes left is nowhere near finished, though it's 2.5%.
    expect(isEffectivelyFinished(72000 - 1800, 72000)).toBe(false);
    expect(isEffectivelyFinished(72000 - 45, 72000)).toBe(true);
    expect(isEffectivelyFinished(72000, 72000)).toBe(true);
  });
  it("is false with no duration", () => {
    expect(isEffectivelyFinished(0, 0)).toBe(false);
  });
});

describe("clampRate", () => {
  it("keeps rates within bounds and sane", () => {
    expect(clampRate(1.25)).toBe(1.25);
    expect(clampRate(10)).toBe(3);
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(NaN)).toBe(1);
    expect(clampRate(1.333)).toBe(1.33);
  });
});
