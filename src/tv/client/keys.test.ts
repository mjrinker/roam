import { describe, expect, it } from "vitest";
import { actionOf, directionOf, TIZEN_MEDIA_KEYS } from "./keys";

describe("remote keys", () => {
  it("reads the arrows", () => {
    expect([37, 38, 39, 40].map(directionOf)).toEqual(["left", "up", "right", "down"]);
    expect([13, 65, 0].map(directionOf)).toEqual([null, null, null]);
  });
  it("treats every platform's Back key as Back", () => {
    for (const code of [8, 27, 10009, 461, 4]) expect(actionOf(code), String(code)).toBe("back");
  });
  it("reads OK and the media keys of Tizen and webOS", () => {
    expect(actionOf(13)).toBe("enter");
    expect([415, 19, 10252, 413, 417, 412].map(actionOf)).toEqual(["play", "pause", "playpause", "stop", "forward", "rewind"]);
    expect(actionOf(999)).toBeNull();
  });
  it("asks Tizen for the media keys by name", () => {
    expect(TIZEN_MEDIA_KEYS).toContain("MediaPlayPause");
    expect(new Set(TIZEN_MEDIA_KEYS).size).toBe(TIZEN_MEDIA_KEYS.length);
  });
});
