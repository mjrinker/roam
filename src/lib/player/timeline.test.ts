import { describe, expect, it } from "vitest";
import {
  buildPlaySegment,
  chapterEnd,
  chapterIndexAt,
  clampRate,
  crossedVirtualEnd,
  findSegmentAt,
  formatClock,
  hasVirtualEnd,
  isEffectivelyFinished,
  remainingInSegment,
  toElementTime,
  toLocalTime,
  windowClampTarget,
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
  it("scales down for short items: a 45-second clip or a 3-minute track isn't finished until nearly the end", () => {
    expect(isEffectivelyFinished(0, 45)).toBe(false); // used to be "finished" from the first save
    expect(isEffectivelyFinished(20, 45)).toBe(false);
    expect(isEffectivelyFinished(44.5, 45)).toBe(true);
    expect(isEffectivelyFinished(130, 180)).toBe(false); // paused at 2:10 of a 3-minute track keeps its place
    expect(isEffectivelyFinished(177, 180)).toBe(true);
    // The cap for long items is unchanged, and the share takes over only below 50 minutes.
    expect(isEffectivelyFinished(3000 - 61, 3000)).toBe(false);
    expect(isEffectivelyFinished(3000 - 59, 3000)).toBe(true);
    expect(isEffectivelyFinished(1800 - 40, 1800)).toBe(false); // 30 minutes: 36 seconds
    expect(isEffectivelyFinished(1800 - 30, 1800)).toBe(true);
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

describe("trimmed segments", () => {
  const untrimmed = { durationSeconds: 2640 };
  const firstHalf = { durationSeconds: 1320, inFileOffsetSeconds: 0, inFileEndSeconds: 1320 };
  const secondHalf = { durationSeconds: 1320, inFileOffsetSeconds: 1320, inFileEndSeconds: 2640 };

  describe("hasVirtualEnd", () => {
    it("is false for an ordinary segment, true for a trimmed one", () => {
      expect(hasVirtualEnd(untrimmed)).toBe(false);
      expect(hasVirtualEnd(firstHalf)).toBe(true);
      expect(hasVirtualEnd(secondHalf)).toBe(true);
    });
  });

  describe("toElementTime / toLocalTime", () => {
    it("are identity for an untrimmed segment, including past its own duration", () => {
      expect(toElementTime(untrimmed, 0)).toBe(0);
      expect(toElementTime(untrimmed, 500)).toBe(500);
      expect(toLocalTime(untrimmed, 500)).toBe(500);
      expect(toLocalTime(untrimmed, 1_000_000)).toBe(1_000_000);
      expect(toLocalTime(untrimmed, -5)).toBe(-5);
    });

    it("offsets by the window start for a trimmed segment", () => {
      expect(toElementTime(firstHalf, 0)).toBe(0);
      expect(toElementTime(secondHalf, 10)).toBe(1330);
      expect(toLocalTime(secondHalf, 1330)).toBe(10);
    });

    it("clamps local time to [0, durationSeconds] only when trimmed", () => {
      // Element time before the window's own start (shouldn't normally
      // happen, but native seeks can land anywhere) clamps to 0, not negative.
      expect(toLocalTime(secondHalf, 1000)).toBe(0);
      // Past the window's end clamps to durationSeconds, not overshooting.
      expect(toLocalTime(firstHalf, 5000)).toBe(1320);
    });
  });

  describe("crossedVirtualEnd", () => {
    it("is always false for an untrimmed segment", () => {
      expect(crossedVirtualEnd(untrimmed, 0)).toBe(false);
      expect(crossedVirtualEnd(untrimmed, 1e6)).toBe(false);
    });

    it("fires within epsilon of the virtual end, not before", () => {
      expect(crossedVirtualEnd(firstHalf, 1319.7)).toBe(false);
      expect(crossedVirtualEnd(firstHalf, 1319.8)).toBe(true);
      expect(crossedVirtualEnd(firstHalf, 1320)).toBe(true);
    });
  });

  describe("remainingInSegment", () => {
    it("uses the physical element duration for an untrimmed segment", () => {
      expect(remainingInSegment(untrimmed, 100, 2640)).toBe(2540);
    });

    it("uses the window's own remaining time for a trimmed segment, ignoring element duration", () => {
      expect(remainingInSegment(firstHalf, 1310, 2640)).toBe(10);
      expect(remainingInSegment(secondHalf, 2630, 2640)).toBe(10);
    });
  });

  describe("windowClampTarget", () => {
    it("is null for an untrimmed segment", () => {
      expect(windowClampTarget(untrimmed, 99999)).toBeNull();
    });

    it("is null when already inside the window (within tolerance)", () => {
      expect(windowClampTarget(secondHalf, 1320.05)).toBeNull();
      expect(windowClampTarget(secondHalf, 2000)).toBeNull();
    });

    it("clamps to the nearest boundary when outside the window", () => {
      expect(windowClampTarget(secondHalf, 1000)).toBe(1320);
      expect(windowClampTarget(firstHalf, 2000)).toBe(1320);
    });
  });
});

describe("buildPlaySegment", () => {
  it("omits the trim keys entirely for an ordinary row — not even as undefined", () => {
    const segment = buildPlaySegment(
      { durationSeconds: 1320, trimStartSeconds: null, trimDurationSeconds: null },
      0,
      "https://example.com/a",
      0
    );
    expect(Object.keys(segment).sort()).toEqual(["durationSeconds", "index", "startSeconds", "url"]);
    expect(segment).toEqual({ index: 0, url: "https://example.com/a", durationSeconds: 1320, startSeconds: 0 });
  });

  it("builds a trimmed segment from a row's trim window, offset by startSeconds", () => {
    const segment = buildPlaySegment(
      { durationSeconds: 2640, trimStartSeconds: 1320, trimDurationSeconds: 1320 },
      1,
      "https://example.com/b",
      1320
    );
    expect(segment).toEqual({
      index: 1,
      url: "https://example.com/b",
      durationSeconds: 1320,
      startSeconds: 1320,
      inFileOffsetSeconds: 1320,
      inFileEndSeconds: 2640,
    });
  });

  it("still sets inFileEndSeconds for a first-half segment whose trim offset is 0", () => {
    const segment = buildPlaySegment(
      { durationSeconds: 2640, trimStartSeconds: 0, trimDurationSeconds: 1320 },
      0,
      "https://example.com/a",
      0
    );
    expect(segment.inFileOffsetSeconds).toBe(0);
    expect(segment.inFileEndSeconds).toBe(1320);
    expect(hasVirtualEnd(segment)).toBe(true);
  });

  it("treats a null trimStartSeconds as an offset of 0 for a trimmed row", () => {
    const segment = buildPlaySegment(
      { durationSeconds: 2640, trimStartSeconds: null, trimDurationSeconds: 1320 },
      0,
      "https://example.com/a",
      0
    );
    expect(segment.inFileOffsetSeconds).toBe(0);
    expect(segment.inFileEndSeconds).toBe(1320);
  });
});
