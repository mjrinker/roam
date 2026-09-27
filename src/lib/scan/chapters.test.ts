import { describe, expect, it } from "vitest";
import { alignAudnexusChapters, embeddedChapters, partTitle, perFileChapters } from "./chapters";

const part = (filename: string, seconds: number, chapters: { title: string; startSeconds: number }[] | null = null) => ({
  filename,
  durationMs: seconds * 1000,
  chapters,
});

describe("partTitle", () => {
  it("cleans track numbers and extensions", () => {
    expect(partTitle("03 - The Storm.mp3", 2)).toBe("The Storm");
    expect(partTitle("Chapter 4.mp3", 3)).toBe("Chapter 4");
  });
  it("names bare split markers and numbers by position", () => {
    expect(partTitle("Book - pt2.mp3", 1)).toBe("Part 2");
    expect(partTitle("Disc 3.mp3", 2)).toBe("Part 3");
    expect(partTitle("07.mp3", 6)).toBe("Part 7");
  });
});

describe("embeddedChapters", () => {
  it("returns null when no part has chapters", () => {
    expect(embeddedChapters([part("a.mp3", 100), part("b.mp3", 100)])).toBeNull();
  });

  it("offsets each part's chapters by the parts before it", () => {
    const result = embeddedChapters([
      part("a.m4b", 600, [{ title: "One", startSeconds: 0 }, { title: "Two", startSeconds: 300 }]),
      part("b.m4b", 400, [{ title: "Three", startSeconds: 0 }, { title: "Four", startSeconds: 100.5 }]),
    ]);
    expect(result).toEqual([
      { title: "One", startSeconds: 0 },
      { title: "Two", startSeconds: 300 },
      { title: "Three", startSeconds: 600 },
      { title: "Four", startSeconds: 700.5 },
    ]);
  });

  it("gives a chapterless part a single chapter covering it", () => {
    const result = embeddedChapters([
      part("a.m4b", 600, [{ title: "One", startSeconds: 0 }]),
      part("b - pt2.m4b", 400),
    ]);
    expect(result?.[1]).toEqual({ title: "Part 2", startSeconds: 600 });
  });
});

describe("perFileChapters", () => {
  it("makes one chapter per file at cumulative offsets", () => {
    expect(perFileChapters([part("01 - A.mp3", 100), part("02 - B.mp3", 50)])).toEqual([
      { title: "A", startSeconds: 0 },
      { title: "B", startSeconds: 100 },
    ]);
  });
  it("returns null for a single file", () => {
    expect(perFileChapters([part("book.m4b", 100)])).toBeNull();
  });
});

describe("alignAudnexusChapters", () => {
  const aud = {
    introMs: 2000,
    outroMs: 5000,
    runtimeMs: 3_600_000,
    chapters: [
      { title: "Opening Credits", startSeconds: 0, lengthSeconds: 2 },
      { title: "Chapter 1", startSeconds: 2, lengthSeconds: 1798 },
      { title: "Chapter 2", startSeconds: 1800, lengthSeconds: 1795 },
      { title: "End Credits", startSeconds: 3595, lengthSeconds: 5 },
    ],
  };

  it("uses the list as-is when the runtimes match", () => {
    const result = alignAudnexusChapters(aud, 3_600_000);
    expect(result?.map((c) => c.startSeconds)).toEqual([0, 2, 1800, 3595]);
  });

  it("shifts by the brand intro when the file has intro and outro trimmed", () => {
    // File is 3600 - 2 - 5 = 3593 seconds: the exact alignment beats the
    // loose as-is fit that is also inside the 2% tolerance.
    const result = alignAudnexusChapters(aud, 3_593_000);
    expect(result?.map((c) => [c.title, c.startSeconds])).toEqual([
      ["Chapter 1", 0],
      ["Chapter 2", 1798],
    ]);
  });

  it("drops chapters that fall entirely outside the trimmed file", () => {
    const result = alignAudnexusChapters(aud, 3_593_000);
    expect(result?.map((c) => c.title)).toEqual(["Chapter 1", "Chapter 2"]);
  });

  it("rejects a runtime that doesn't fit any alignment", () => {
    expect(alignAudnexusChapters(aud, 1_800_000)).toBeNull();
  });

  it("returns null with no chapters", () => {
    expect(alignAudnexusChapters({ ...aud, chapters: [] }, 3_600_000)).toBeNull();
  });
});
