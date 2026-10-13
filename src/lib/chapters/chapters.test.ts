import { describe, expect, it } from "vitest";
import { chapterIndexAtTime, cleanChapters, playbackChapters, snapToChapter } from "./chapters";

describe("cleanChapters", () => {
  it("sorts, drops duplicates and impossible times, and names blanks", () => {
    expect(cleanChapters([{ title: "B", startSeconds: 300 }, { title: "", startSeconds: 0 }, { title: "dup", startSeconds: 300.2 }, { title: "late", startSeconds: 99999 }, { title: "neg", startSeconds: -3 }], 3600)).toEqual([
      { title: "Chapter 1", startSeconds: 0 },
      { title: "B", startSeconds: 300 },
    ]);
  });
  it("drops a chapter right at the very end", () => {
    expect(cleanChapters([{ title: "a", startSeconds: 0 }, { title: "end", startSeconds: 3599 }], 3600)).toHaveLength(1);
  });
});

describe("playbackChapters", () => {
  const parts = [
    { startSeconds: 0, durationSeconds: 3000, chapters: [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 1500 }] },
    { startSeconds: 3000, durationSeconds: 3000, chapters: [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 1000 }] },
  ];
  it("puts each part's chapters on one clock and renumbers placeholder titles across the parts", () => {
    expect(playbackChapters(parts, 6000)).toEqual([
      { title: "Chapter 1", startSeconds: 0 },
      { title: "Chapter 2", startSeconds: 1500 },
      { title: "Chapter 3", startSeconds: 3000 },
      { title: "Chapter 4", startSeconds: 4000 },
    ]);
  });
  it("marks no part boundary of its own: a part with no chapter at its start adds none there", () => {
    const out = playbackChapters(
      [
        { startSeconds: 0, durationSeconds: 3000, chapters: [{ title: "Act one", startSeconds: 0 }, { title: "Twist", startSeconds: 2000 }] },
        { startSeconds: 3000, durationSeconds: 3000, chapters: [{ title: "Showdown", startSeconds: 500 }] },
      ],
      6000
    );
    expect(out.map((c) => c.startSeconds)).toEqual([0, 2000, 3500]);
  });
  it("shows a chapter that lines up with a part boundary once, as the chapter", () => {
    const out = playbackChapters(
      [
        { startSeconds: 0, durationSeconds: 3000, chapters: [{ title: "One", startSeconds: 0 }] },
        { startSeconds: 3000, durationSeconds: 3000, chapters: [{ title: "Two", startSeconds: 0 }, { title: "Three", startSeconds: 900 }] },
      ],
      6000
    );
    expect(out).toEqual([
      { title: "One", startSeconds: 0 },
      { title: "Two", startSeconds: 3000 },
      { title: "Three", startSeconds: 3900 },
    ]);
  });
  it("keeps only the chapters inside a trimmed segment's window, timed from its start", () => {
    const out = playbackChapters(
      [{ startSeconds: 0, durationSeconds: 1800, inFileOffsetSeconds: 1800, inFileEndSeconds: 3600, chapters: [{ title: "a", startSeconds: 100 }, { title: "b", startSeconds: 1800 }, { title: "c", startSeconds: 2400 }, { title: "d", startSeconds: 3700 }] }],
      1800
    );
    expect(out).toEqual([
      { title: "b", startSeconds: 0 },
      { title: "c", startSeconds: 600 },
    ]);
  });
  it("shows nothing for fewer than two chapters", () => {
    expect(playbackChapters([{ startSeconds: 0, durationSeconds: 3000, chapters: [{ title: "Only", startSeconds: 0 }] }], 3000)).toEqual([]);
    expect(playbackChapters([{ startSeconds: 0, durationSeconds: 3000, chapters: null }], 3000)).toEqual([]);
  });
});

describe("chapterIndexAtTime", () => {
  const ch = [{ title: "a", startSeconds: 0 }, { title: "b", startSeconds: 100 }];
  it("finds the chapter playing", () => {
    expect(chapterIndexAtTime(ch, 0)).toBe(0);
    expect(chapterIndexAtTime(ch, 99)).toBe(0);
    expect(chapterIndexAtTime(ch, 100)).toBe(1);
    expect(chapterIndexAtTime([], 5)).toBe(-1);
  });
});

describe("snapToChapter", () => {
  const ch = [{ title: "a", startSeconds: 0 }, { title: "b", startSeconds: 1000 }, { title: "c", startSeconds: 1100 }];
  // 4000s across 800px: 0.2px per second, so 10px is 50s.
  it("snaps to a mark within the threshold on screen", () => {
    expect(snapToChapter(1030, ch, 4000, 800)).toEqual({ time: 1000, chapter: ch[1] });
    expect(snapToChapter(960, ch, 4000, 800).chapter).toBe(ch[1]);
  });
  it("leaves the time alone when no mark is near", () => {
    expect(snapToChapter(2000, ch, 4000, 800)).toEqual({ time: 2000, chapter: null });
  });
  it("takes the nearest of two close marks", () => {
    expect(snapToChapter(1080, ch, 4000, 800).chapter).toBe(ch[2]);
  });
  it("is about pixels, not seconds: a long film pulls from further away", () => {
    expect(snapToChapter(1100 - 40, ch, 4000, 800).chapter).toBe(ch[2]);
    expect(snapToChapter(1100 - 40, ch, 400, 800).chapter).toBeNull();
  });
  it("does nothing without chapters or a bar", () => {
    expect(snapToChapter(5, [], 100, 800)).toEqual({ time: 5, chapter: null });
    expect(snapToChapter(5, ch, 100, 0)).toEqual({ time: 5, chapter: null });
  });
});
