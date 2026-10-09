import { describe, expect, it } from "vitest";
import { buildVersionArgs, MAX_OUTPUT_BYTES, originalLabel, RUNGS, rungsBelow, rungSize, videoKbps } from "./version-plan";
import { withVersionLabel, splitVersionLabel } from "@/lib/scan/conventions";
import { parseVideoInfo } from "./ffmpeg-probe";

describe("which rungs to make", () => {
  it("makes every rung below the source's own resolution, never an upscale", () => {
    expect(rungsBelow(3840, 2160)).toEqual([1440, 1080, 720, 480, 360, 240, 144]);
    expect(rungsBelow(1920, 1080)).toEqual([720, 480, 360, 240, 144]);
    expect(rungsBelow(1280, 720)).toEqual([480, 360, 240, 144]);
    expect(rungsBelow(640, 360)).toEqual([240, 144]);
    expect(rungsBelow(256, 144)).toEqual([]);
  });
  it("counts a cropped widescreen film by its width, and doesn't remake the source's own label", () => {
    expect(rungsBelow(1920, 800)).toEqual([720, 480, 360, 240, 144]);
    expect(originalLabel(1920, 800)).toBe("1080p");
    expect(rungsBelow(1280, 534)).toEqual([480, 360, 240, 144]); // 720p in disguise
    expect(rungsBelow(1280, 534)).not.toContain(720);
  });
  it("labels the original by what it is", () => {
    expect([originalLabel(3840, 2160), originalLabel(2560, 1440), originalLabel(1920, 1080), originalLabel(1280, 720), originalLabel(720, 576), originalLabel(854, 480)]).toEqual(["2160p", "1440p", "1080p", "720p", "576p", "480p"]);
  });
  it("limits to the rungs asked for", () => {
    expect(rungsBelow(1920, 1080, [720, 240])).toEqual([720, 240]);
  });
  it("knows the whole ladder", () => {
    expect([...RUNGS]).toEqual([2160, 1440, 1080, 720, 480, 360, 240, 144]);
  });
});

describe("sizes and bitrates", () => {
  it("scales to the rung keeping the shape, with even numbers", () => {
    expect(rungSize(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(rungSize(1920, 800, 720)).toEqual({ width: 1280, height: 534 });
    expect(rungSize(1440, 1080, 480)).toEqual({ width: 640, height: 480 });
    expect(rungSize(3840, 2160, 144)).toEqual({ width: 256, height: 144 });
  });
  it("uses the rung's ceiling, lowered so a long film fits under the file size limit", () => {
    expect(videoKbps(1080, 3600)).toBe(4000);
    expect(videoKbps(1080, 2 * 3600)).toBeLessThan(4000); // two hours at 4 Mbit/s would pass the limit
    expect(videoKbps(1440, 3 * 3600)).toBeLessThan(6000);
    const kbps = videoKbps(1440, 3 * 3600);
    expect(((kbps + 128 + 32) * 1000 * 3 * 3600) / 8).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(videoKbps(720, null)).toBe(2500);
    expect(videoKbps(144, 100 * 3600)).toBeGreaterThanOrEqual(100);
  });
  it("builds ffmpeg arguments for the size, bitrate and a plain faststart file", () => {
    const args = buildVersionArgs("in.mp4", "out.mp4", { width: 1920, height: 1080, rung: 720, kbps: 2500, preset: "medium", crf: 23 });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-vf")).toBe("scale=1280:720:flags=lanczos,format=yuv420p");
    expect([at("-c:v"), at("-crf"), at("-maxrate"), at("-bufsize"), at("-c:a"), at("-ac"), at("-b:a"), at("-movflags")]).toEqual(["libx264", "23", "2500k", "5000k", "aac", "2", "128k", "+faststart"]);
    expect(args.slice(-1)).toEqual(["out.mp4"]);
    expect(args).toContain("0:a:0?");
  });
});

describe("naming the files", () => {
  it("adds the label at the end of a movie or episode name", () => {
    expect(withVersionLabel("Movie (2020).mp4", "1080p")).toBe("Movie (2020) - 1080p.mp4");
    expect(withVersionLabel("Movie (2020) {tmdb-603}.mp4", "720p")).toBe("Movie (2020) {tmdb-603} - 720p.mp4");
    expect(withVersionLabel("Show - s01e01 - Pilot.mp4", "480p")).toBe("Show - s01e01 - Pilot - 480p.mp4");
  });
  it("keeps the parts of a version together by putting the label before the part marker", () => {
    expect(withVersionLabel("Movie (2020) - pt1.mp4", "1080p")).toBe("Movie (2020) - 1080p - pt1.mp4");
    expect(withVersionLabel("Show - s01e02 - cd2.mp4", "360p")).toBe("Show - s01e02 - 360p - cd2.mp4");
  });
  it("leaves an already labelled name alone, and what it makes parses back to the same label", () => {
    expect(withVersionLabel("Movie - 4K.mp4", "1080p")).toBe("Movie - 4K.mp4");
    for (const name of ["Movie (2020).mp4", "Movie (2020) - pt2.mp4", "Show - S01E05-E06 - Title.mp4", "part1.mp4"]) {
      expect(splitVersionLabel(withVersionLabel(name, "144p")).label).toBe("144p");
    }
  });
});

describe("reading a video's size out of ffmpeg's summary", () => {
  const summary = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':
  Duration: 01:42:03.50, start: 0.000000, bitrate: 5000 kb/s
    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x800 [SAR 1:1 DAR 12:5], 4800 kb/s, 23.98 fps
    Stream #0:1(und): Audio: ac3 (ac-3 / 0x332D6361), 48000 Hz, 5.1(side), fltp, 448 kb/s`;
  it("finds the size and length", () => {
    expect(parseVideoInfo(summary)).toEqual({ width: 1920, height: 800, durationSeconds: 6123.5 });
  });
  it("is null with no video, and ignores cover art", () => {
    expect(parseVideoInfo("Stream #0:0: Audio: aac, 44100 Hz, stereo")).toBeNull();
    expect(parseVideoInfo("Stream #0:1: Video: mjpeg, yuvj420p, 600x600, 90k tbr (attached pic)")).toBeNull();
  });
});
