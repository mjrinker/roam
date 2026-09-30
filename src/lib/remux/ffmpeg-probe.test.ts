import { describe, expect, it } from "vitest";
import { channelsFromLayout, parseFirstAudioStream } from "./ffmpeg-probe";

const header = (audio: string) => `Input #0, mov,mp4, from 'x.mp4':
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080, 4000 kb/s
  Stream #0:1[0x2](eng): Audio: ${audio}
At least one output file must be specified`;

describe("parseFirstAudioStream", () => {
  it("reads codec and channels from an AC-3 5.1 stream", () => {
    expect(
      parseFirstAudioStream(header("ac3 (ac-3 / 0x332D6361), 48000 Hz, 5.1(side), fltp, 448 kb/s (default)"))
    ).toEqual({ codec: "ac3", channels: 6 });
  });

  it("reads stereo AAC", () => {
    expect(parseFirstAudioStream(header("aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s"))).toEqual({
      codec: "aac",
      channels: 2,
    });
  });

  it("handles 'N channels' layouts and dts", () => {
    expect(parseFirstAudioStream(header("dts (DTS), 48000 Hz, 6 channels, fltp, 1536 kb/s"))).toEqual({
      codec: "dts",
      channels: 6,
    });
  });

  it("uses only the first audio stream", () => {
    const text = header("eac3, 48000 Hz, 7.1, fltp") + "\n  Stream #0:2: Audio: aac, 48000 Hz, stereo";
    expect(parseFirstAudioStream(text)).toEqual({ codec: "eac3", channels: 8 });
  });

  it("returns null when there is no audio", () => {
    expect(parseFirstAudioStream("  Stream #0:0: Video: h264, yuv420p")).toBeNull();
  });
});

describe("channelsFromLayout", () => {
  it("maps common layouts", () => {
    expect(channelsFromLayout("mono")).toBe(1);
    expect(channelsFromLayout("5.1(side)")).toBe(6);
    expect(channelsFromLayout("fltp")).toBeNull();
  });
});
