import { describe, expect, it } from "vitest";
import { isBrowserSafeAudioCodec, needsAudioFix, UNSUPPORTED_AUDIO_CODECS } from "./codec-support";

describe("isBrowserSafeAudioCodec", () => {
  it("treats mp4a (AAC/MP3-in-MP4) as safe", () => {
    expect(isBrowserSafeAudioCodec("mp4a")).toBe(true);
  });

  it("treats null (no audio track, or not yet probed) as safe", () => {
    expect(isBrowserSafeAudioCodec(null)).toBe(true);
  });

  it("treats an unrecognized codec as safe, not flagged", () => {
    expect(isBrowserSafeAudioCodec("xyz9")).toBe(true);
  });

  it.each(UNSUPPORTED_AUDIO_CODECS)("flags %s as unsafe", (codec) => {
    expect(isBrowserSafeAudioCodec(codec)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBrowserSafeAudioCodec("AC-3")).toBe(false);
    expect(isBrowserSafeAudioCodec("Ac-3")).toBe(false);
  });
});

describe("needsAudioFix", () => {
  it("is true only for a flagged codec without a linked remux", () => {
    expect(needsAudioFix([{ audioCodec: "ac-3", remuxStatus: null }])).toBe(true);
    expect(needsAudioFix([{ audioCodec: "ac-3", remuxStatus: "failed" }])).toBe(true);
    expect(needsAudioFix([{ audioCodec: "ac-3", remuxStatus: "done" }])).toBe(false);
    expect(needsAudioFix([{ audioCodec: "mp4a", remuxStatus: null }])).toBe(false);
    expect(needsAudioFix([{ audioCodec: null, remuxStatus: null }])).toBe(false);
    expect(needsAudioFix([{ audioCodec: "mp4a", remuxStatus: null }, { audioCodec: "ec-3", remuxStatus: null }])).toBe(true);
  });
});
