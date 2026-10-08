import { describe, expect, it } from "vitest";
import { formatClock, isFinished, locate, timelineAt, type Segment } from "./clock";

const seg = (index: number, startSeconds: number, durationSeconds: number, extra: Partial<Segment> = {}): Segment => ({ index, url: `u${index}`, startSeconds, durationSeconds, ...extra });

describe("formatClock", () => {
  it("shows minutes and seconds, adds hours past an hour, and copes with nonsense", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725.9)).toBe("1:02:05");
    for (const bad of [-5, NaN, Infinity]) expect(formatClock(bad)).toBe("0:00");
  });
});

describe("locate", () => {
  const parts = [seg(0, 0, 100), seg(1, 100, 50), seg(2, 150, 200)];
  it("finds the part and the place in it", () => {
    expect(locate(parts, 0)).toMatchObject({ segment: { index: 0 }, localTime: 0 });
    expect(locate(parts, 99.5)).toMatchObject({ segment: { index: 0 }, localTime: 99.5 });
    expect(locate(parts, 100)).toMatchObject({ segment: { index: 1 }, localTime: 0 });
    expect(locate(parts, 160)).toMatchObject({ segment: { index: 2 }, localTime: 10 });
  });
  it("puts anything past the end at the end of the last part, and anything before the start at the start", () => {
    expect(locate(parts, 9999)).toMatchObject({ segment: { index: 2 }, localTime: 200 });
    expect(locate(parts, -50)).toMatchObject({ segment: { index: 0 }, localTime: 0 });
  });
  it("adds the file offset of a trimmed part (an episode cut from a longer file)", () => {
    const trimmed = [seg(0, 0, 600, { inFileOffsetSeconds: 1200, inFileEndSeconds: 1800 })];
    expect(locate(trimmed, 30)).toMatchObject({ localTime: 1230 });
    expect(timelineAt(trimmed[0], 1230)).toBe(30);
    expect(timelineAt(trimmed[0], 1100)).toBe(0); // before its window: the start
  });
});

describe("isFinished", () => {
  it("counts the last half minute or 97 percent as watched, and nothing for an unknown length", () => {
    expect(isFinished(5400, 5430)).toBe(true);
    expect(isFinished(5399, 6000)).toBe(false);
    expect(isFinished(98, 100)).toBe(true);
    expect(isFinished(10, 0)).toBe(false);
  });
});
