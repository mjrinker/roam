import { describe, expect, it } from "vitest";
import { airPlayUsable, castGlobal, castItems, castPosition } from "./cast";

const manifest = {
  segments: [
    { index: 0, url: "https://a/0", durationSeconds: 100, startSeconds: 0, container: "mp4" },
    { index: 1, url: "https://a/1", durationSeconds: 80, startSeconds: 100, container: "mkv" },
    { index: 2, url: "https://a/2", durationSeconds: 60, startSeconds: 180 },
  ],
};

describe("casting a video in parts", () => {
  it("makes one item per file with its type", () => {
    expect(castItems(manifest).map((i) => [i.url, i.contentType, i.startSeconds])).toEqual([["https://a/0", "video/mp4", 0], ["https://a/1", "video/x-matroska", 100], ["https://a/2", "video/mp4", 180]]);
  });
  it("finds the file and the time in it for a place in the whole video, and back", () => {
    const items = castItems(manifest);
    expect(castPosition(items, 0)).toEqual({ index: 0, seconds: 0 });
    expect(castPosition(items, 99.5)).toEqual({ index: 0, seconds: 99.5 });
    expect(castPosition(items, 150)).toEqual({ index: 1, seconds: 50 });
    expect(castPosition(items, 500)).toEqual({ index: 2, seconds: 320 });
    expect(castGlobal(items, 1, 50)).toBe(150);
  });
  it("offers AirPlay only for one file, in a browser that has it", () => {
    const one = { segments: [manifest.segments[0]] };
    expect(airPlayUsable(one, { webkitShowPlaybackTargetPicker: () => undefined })).toBe(true);
    expect(airPlayUsable(manifest, { webkitShowPlaybackTargetPicker: () => undefined })).toBe(false);
    expect(airPlayUsable(one, {})).toBe(false);
    expect(airPlayUsable(null, null)).toBe(false);
  });
});
