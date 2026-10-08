import { describe, expect, it } from "vitest";
import { clipEncodeArgs } from "./encode";

describe("clipEncodeArgs", () => {
  const args = clipEncodeArgs("/in/film.mkv", "/out/clip.mp4", 120, 45);
  const has = (...seq: string[]) => args.join("\u0000").includes(seq.join("\u0000"));

  it("cuts exactly the planned piece from the right file to the right place", () => {
    expect(has("-ss", "120", "-t", "45", "-i", "/in/film.mkv")).toBe(true);
    expect(args[args.length - 1]).toBe("/out/clip.mp4");
  });
  it("keeps only the main picture and sound, and drops chapters, tags, subtitles and data tracks", () => {
    expect(has("-map", "0:v:0", "-map", "0:a:0")).toBe(true);
    expect(has("-map_chapters", "-1")).toBe(true);
    expect(has("-map_metadata", "-1")).toBe(true);
    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
  });
  it("makes a browser-friendly file: H.264, AAC stereo, index first, never enlarged past 720p", () => {
    expect(has("-c:v", "libx264")).toBe(true);
    expect(has("-c:a", "aac")).toBe(true);
    expect(has("-ac", "2")).toBe(true);
    expect(has("-movflags", "+faststart")).toBe(true);
    expect(args).toContain("scale=-2:min(720\\,ih)");
  });
  it("overwrites nothing silently: -y is explicit, output is last", () => {
    expect(args).toContain("-y");
  });
});
