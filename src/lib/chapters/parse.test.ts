import { describe, expect, it } from "vitest";
import { chapterFileVideoBase, isChapterFile, parseChapterFile, parseChapterText, parseClock, parseMatroskaXml, parseWebVtt } from "./parse";

describe("chapter file names", () => {
  it("knows a chapter file and the video it belongs to", () => {
    expect(isChapterFile("The Matrix (1999).chapters.xml")).toBe(true);
    expect(isChapterFile("Show - S01E01.CHAPTERS.TXT")).toBe(true);
    expect(isChapterFile("Movie.chapters.vtt")).toBe(true);
    expect(isChapterFile("Movie.chapters.srt")).toBe(false);
    expect(isChapterFile("Movie.mp4")).toBe(false);
    expect(chapterFileVideoBase("Movie - pt1.chapters.txt")).toBe("Movie - pt1");
    expect(chapterFileVideoBase("Movie.mp4")).toBeNull();
  });
});

describe("parseClock", () => {
  it("reads clock times", () => {
    expect(parseClock("1:02:30")).toBe(3750);
    expect(parseClock("02:30")).toBe(150);
    expect(parseClock("00:05:00.500")).toBe(300.5);
    expect(parseClock("00:00:05,250")).toBe(5.25);
    expect(parseClock("00:05:00.000000000")).toBe(300);
    expect(parseClock("90")).toBe(90);
  });
  it("refuses what isn't a time", () => {
    for (const bad of ["", "abc", "1:2:3:4", "-5", "12:xx", "99999999"]) expect(parseClock(bad), bad).toBeNull();
  });
});

describe("Matroska XML", () => {
  const xml = `<?xml version="1.0"?><Chapters><EditionEntry>
    <ChapterAtom><ChapterTimeStart>00:00:00.000000000</ChapterTimeStart><ChapterDisplay><ChapterString>Opening &amp; titles</ChapterString><ChapterLanguage>eng</ChapterLanguage></ChapterDisplay></ChapterAtom>
    <ChapterAtom><ChapterTimeStart>00:10:30.250000000</ChapterTimeStart><ChapterDisplay><ChapterString>The chase</ChapterString></ChapterDisplay>
      <ChapterAtom><ChapterTimeStart>00:12:00.000000000</ChapterTimeStart><ChapterDisplay><ChapterString>Nested</ChapterString></ChapterDisplay></ChapterAtom>
    </ChapterAtom>
    <ChapterAtom><ChapterFlagHidden>1</ChapterFlagHidden><ChapterTimeStart>00:20:00.000000000</ChapterTimeStart><ChapterDisplay><ChapterString>Hidden</ChapterString></ChapterDisplay></ChapterAtom>
  </EditionEntry></Chapters>`;
  it("reads each visible atom's time and name, including nested ones", () => {
    expect(parseMatroskaXml(xml)).toEqual([
      { title: "Opening & titles", startSeconds: 0 },
      { title: "The chase", startSeconds: 630.25 },
      { title: "Nested", startSeconds: 720 },
    ]);
  });
  it("gives nothing for broken input", () => {
    expect(parseMatroskaXml("<Chapters><ChapterAtom><ChapterTimeStart>soon")).toEqual([]);
    expect(parseMatroskaXml("not xml at all")).toEqual([]);
  });
});

describe("text chapters", () => {
  it("reads the OGM simple format", () => {
    const txt = "CHAPTER01=00:00:00.000\nCHAPTER01NAME=Opening\nCHAPTER02=00:12:34.500\nCHAPTER02NAME=Heist\nCHAPTER03=01:30:00.000\n";
    expect(parseChapterText(txt)).toEqual([
      { title: "Opening", startSeconds: 0 },
      { title: "Heist", startSeconds: 754.5 },
      { title: "", startSeconds: 5400 },
    ]);
  });
  it("reads one chapter per line, in the ways people write them", () => {
    const txt = "﻿# my chapters\n0:00 Opening\n[12:34] The heist\n1:02:30 - Finale\n(1:30:00) Credits\nnot a chapter\n";
    expect(parseChapterText(txt)).toEqual([
      { title: "Opening", startSeconds: 0 },
      { title: "The heist", startSeconds: 754 },
      { title: "Finale", startSeconds: 3750 },
      { title: "Credits", startSeconds: 5400 },
    ]);
  });
});

describe("WebVTT", () => {
  it("takes each cue's start as a chapter and its text as the title", () => {
    const vtt = "WEBVTT\n\nintro\n00:00:00.000 --> 00:05:00.000\nOpening\n\n2\n00:05:00.000 --> 00:09:59.000\n<b>The</b> middle\nof it\n";
    expect(parseWebVtt(vtt)).toEqual([
      { title: "Opening", startSeconds: 0 },
      { title: "The middle of it", startSeconds: 300 },
    ]);
  });
});

describe("parseChapterFile", () => {
  it("picks the parser by extension and never throws", () => {
    expect(parseChapterFile("a.chapters.txt", "0:00 One\n5:00 Two")).toHaveLength(2);
    expect(parseChapterFile("a.chapters.xml", "garbage")).toEqual([]);
    expect(parseChapterFile("a.mp4", "0:00 One")).toEqual([]);
  });
  it("caps what a huge file can produce", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")} Chapter`).join("\n");
    expect(parseChapterText(big).length).toBeLessThanOrEqual(500);
  });
});
