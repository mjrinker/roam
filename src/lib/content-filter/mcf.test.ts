import { describe, expect, it } from "vitest";
import { isMcfFile, mcfFileVideoBase, parseMcf } from "./mcf";

const file = `WEBVTT MovieContentFilter 1.1.0

NOTE
TITLE Ozymandias
TYPE movie

NOTE
START 00:00:04.020
END 01:24:00.100

00:00:06.075 --> 00:00:10.500
violence=high

00:06:14.000 --> 00:06:17.581
language=medium # Some comment
drugs=low=video

00:10:00.000 --> 00:10:05.000
Violence=HIGH=audio
bogus=high
violence=extreme
`;

describe("mcf file names", () => {
  it("knows an .mcf file and the video it belongs to", () => {
    expect(isMcfFile("Movie (2020).mcf")).toBe(true);
    expect(isMcfFile("Movie.MCF")).toBe(true);
    expect(isMcfFile("Movie.vtt")).toBe(false);
    expect(mcfFileVideoBase("Movie (2020).mcf")).toBe("Movie (2020)");
    expect(mcfFileVideoBase("Movie.mp4")).toBeNull();
  });
});

describe("parseMcf", () => {
  it("reads each cue line as a category, strength and channel, with its note", () => {
    expect(parseMcf(file)).toEqual([
      { startSeconds: 6.075, endSeconds: 10.5, category: "violence", severity: "high", channel: "both" },
      { startSeconds: 374, endSeconds: 377.581, category: "language", severity: "medium", channel: "both", note: "Some comment" },
      { startSeconds: 374, endSeconds: 377.581, category: "drugs", severity: "low", channel: "picture" },
      { startSeconds: 600, endSeconds: 605, category: "violence", severity: "high", channel: "sound" },
    ]);
  });
  it("leaves out unknown categories and strengths, and cues that end before they start", () => {
    const out = parseMcf("WEBVTT MovieContentFilter 1.1.0\n\n00:00:10.000 --> 00:00:05.000\nviolence=high\n\n00:00:01.000 --> 00:00:02.000\nsparkles=high\nviolence=huge\n");
    expect(out).toEqual([]);
  });
  it("is not fooled by a file that is not an MCF file", () => {
    expect(parseMcf("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nviolence=high\n")).toEqual([]);
    expect(parseMcf("")).toEqual([]);
    expect(parseMcf("not a file at all")).toEqual([]);
  });
  it("caps what a huge file can produce", () => {
    const cues = Array.from({ length: 5000 }, (_, i) => `00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.500\nviolence=low`).join("\n\n");
    expect(parseMcf(`WEBVTT MovieContentFilter 1.1.0\n\n${cues}`).length).toBeLessThanOrEqual(2000);
  });
});
