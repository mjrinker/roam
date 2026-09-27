import { describe, expect, it } from "vitest";
import { estimateAudioDurationMs } from "./containers";

describe("estimateAudioDurationMs", () => {
  it("assumes 128 kbps for mp3 and 64 kbps for m4b/m4a", () => {
    expect(estimateAudioDurationMs("mp3", 16_000_000)).toBe(1_000_000); // 16MB * 8 / 128k = 1000s
    expect(estimateAudioDurationMs("m4b", 8_000_000)).toBe(1_000_000); // 8MB * 8 / 64k = 1000s
    expect(estimateAudioDurationMs("m4a", 8_000_000)).toBe(1_000_000);
  });

  it("does not guess for video or unknown containers, or missing sizes", () => {
    expect(estimateAudioDurationMs("mp4", 1_000_000)).toBeNull();
    expect(estimateAudioDurationMs("mp3", 0)).toBeNull();
  });
});
