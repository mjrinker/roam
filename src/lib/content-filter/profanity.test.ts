import { describe, expect, it } from "vitest";
import type { Cue } from "@/lib/subtitles/cues";
import { findProfanity, languageCuesFromSubtitles, padSeconds } from "./profanity";

describe("findProfanity", () => {
  it("finds listed words as whole words, with their strength", () => {
    expect(findProfanity("Well damn it").map((m) => m.severity)).toEqual(["low"]);
    expect(findProfanity("you stupid ass").map((m) => m.severity)).toEqual(["medium"]);
    expect(findProfanity("what the fuck is this shit").map((m) => m.severity)).toEqual(["high", "high"]);
  });
  it("is not fooled by words that merely contain one", () => {
    expect(findProfanity("Hello, class! The assassin passed the Scunthorpe shell. Hellen is helpful.")).toEqual([]);
  });
  it("catches the common censored spellings", () => {
    expect(findProfanity("what the f*** and s***").length).toBeGreaterThanOrEqual(1);
  });
  it("counts a span once, at its strongest", () => {
    expect(findProfanity("goddamn")).toHaveLength(1);
    expect(findProfanity("goddamn")[0].severity).toBe("medium");
  });
});

const cue = (start: number, end: number, text: string): Cue => [start, end, text];

describe("languageCuesFromSubtitles", () => {
  it("mutes the word's place in the line, a little wider each side, as sound only", () => {
    // A 4-second line; the word is the middle third of the text.
    const [c] = languageCuesFromSubtitles([cue(100, 104, "xxxxxxx damn xxxxxxx")]);
    expect(c.category).toBe("language");
    expect(c.channel).toBe("sound");
    expect(c.severity).toBe("low");
    expect(c.startSeconds).toBeGreaterThan(100);
    expect(c.startSeconds).toBeLessThan(102);
    expect(c.endSeconds).toBeGreaterThan(102);
    expect(c.endSeconds).toBeLessThan(104.5);
    expect(c.endSeconds - c.startSeconds).toBeGreaterThanOrEqual(0.5);
  });
  it("pads a longer line more, up to a second", () => {
    expect(padSeconds(1)).toBeLessThan(padSeconds(6));
    expect(padSeconds(60)).toBe(1);
  });
  it("applies the offset, never goes before the start of the film, and leaves clean lines alone", () => {
    const out = languageCuesFromSubtitles([cue(0, 1, "shit"), cue(10, 12, "perfectly fine")], -5);
    expect(out).toHaveLength(1);
    expect(out[0].startSeconds).toBe(0);
  });
  it("joins mutes that run into each other, keeping the stronger strength", () => {
    const out = languageCuesFromSubtitles([cue(50, 52, "damn"), cue(52.2, 54, "fuck")]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });
  it("skips nonsense lines (zero length, or longer than dialogue can be) and strips markup first", () => {
    expect(languageCuesFromSubtitles([cue(5, 5, "shit"), cue(0, 600, "shit")])).toEqual([]);
    expect(languageCuesFromSubtitles([cue(5, 7, "<i>hell</i>")])).toHaveLength(1);
  });
  it("keeps no text", () => {
    expect(JSON.stringify(languageCuesFromSubtitles([cue(5, 7, "what the hell")]))).not.toMatch(/hell/);
  });
});
