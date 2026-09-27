import { describe, expect, it } from "vitest";
import { Mp3DurationError, probeMp3, probeMp3DurationSeconds } from "./mp3-duration";

// ── Fixture builders ─────────────────────────────────────────────────────

const zeros = (n: number) => new Array(n).fill(0);
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

function fetcher(bytes: number[]) {
  const data = Uint8Array.from(bytes);
  return async (start: number, end: number) => data.slice(start, end + 1).buffer;
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames, 1152 samples each. */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00];
const MPEG1_FRAME = 417;
/** MPEG-2 Layer III, 64 kbps, 22.05 kHz, stereo: 208-byte frames, 576 samples each. */
const MPEG2_HEADER = [0xff, 0xf3, 0x80, 0x00];
const MPEG2_FRAME = 208;

function frames(header: number[], frameLength: number, count: number, firstFrameExtra: number[] = []) {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const frame = [...header, ...zeros(frameLength - 4)];
    if (i === 0) firstFrameExtra.forEach((b, k) => (frame[k] = b));
    out.push(...frame);
  }
  return out;
}

/** A Xing tag placed right after the header + side info, as it appears in the first frame. */
function xingFrame(header: number[], sideInfo: number, frameLength: number, frameCount: number) {
  const frame = [...header, ...zeros(frameLength - 4)];
  const at = 4 + sideInfo;
  [...ascii("Xing"), ...u32be(1), ...u32be(frameCount)].forEach((b, i) => (frame[at + i] = b));
  return frame;
}

function id3v2(frames: number[], version = 4, extraPadding = 0): number[] {
  const body = [...frames, ...zeros(extraPadding)];
  return [...ascii("ID3"), version, 0, 0, ...syncsafe(body.length), ...body];
}
function id3Frame(id: string, body: number[], version = 4): number[] {
  const size = version === 4 ? syncsafe(body.length) : u32be(body.length);
  return [...ascii(id), ...size, 0, 0, ...body];
}

describe("probeMp3", () => {
  it("estimates a constant-bitrate file from its size", async () => {
    const bytes = frames(MPEG1_HEADER, MPEG1_FRAME, 100);
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.method).toBe("cbr");
    expect(result.durationSeconds).toBeCloseTo((bytes.length * 8) / 128_000, 6);
  });

  it("uses the Xing frame count when present", async () => {
    const bytes = [...xingFrame(MPEG1_HEADER, 32, MPEG1_FRAME, 1000), ...frames(MPEG1_HEADER, MPEG1_FRAME, 5)];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.method).toBe("xing");
    expect(result.durationSeconds).toBeCloseTo((1000 * 1152) / 44100, 6);
  });

  it("uses 576 samples per frame and the MPEG-2 side-info offset", async () => {
    const bytes = [...xingFrame(MPEG2_HEADER, 17, MPEG2_FRAME, 2000), ...frames(MPEG2_HEADER, MPEG2_FRAME, 5)];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.method).toBe("xing");
    expect(result.durationSeconds).toBeCloseTo((2000 * 576) / 22050, 6);
  });

  it("reads a VBRI header", async () => {
    const first = [...MPEG1_HEADER, ...zeros(MPEG1_FRAME - 4)];
    [...ascii("VBRI"), 0, 1, 0, 0, 0, 0, ...u32be(0), ...u32be(500)].forEach((b, i) => (first[36 + i] = b));
    // frames field is at +14 from the tag start: version(2) delay(2) quality(2) bytes(4) frames(4)
    const bytes = [...first, ...frames(MPEG1_HEADER, MPEG1_FRAME, 3)];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.method).toBe("vbri");
    expect(result.durationSeconds).toBeCloseTo((500 * 1152) / 44100, 6);
  });

  it("skips ID3v2 tags (including a big one) and junk padding before the first frame", async () => {
    const audio = frames(MPEG1_HEADER, MPEG1_FRAME, 50);
    const tag = id3v2(id3Frame("TIT2", [3, ...ascii("Hello")]), 4, 300_000);
    const bytes = [...tag, ...zeros(37), ...audio];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    // The estimate covers the audio from the first frame on, not the tag or the padding.
    expect(result.durationSeconds).toBeCloseTo((audio.length * 8) / 128_000, 6);
  });

  it("skips back-to-back ID3v2 tags", async () => {
    const audio = frames(MPEG1_HEADER, MPEG1_FRAME, 20);
    const bytes = [...id3v2([], 4, 50), ...id3v2([], 4, 70), ...audio];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.durationSeconds).toBeCloseTo((audio.length * 8) / 128_000, 6);
  });

  it("excludes a trailing ID3v1 tag from the CBR estimate", async () => {
    const audio = frames(MPEG1_HEADER, MPEG1_FRAME, 40);
    const v1 = [...ascii("TAG"), ...zeros(125)];
    const bytes = [...audio, ...v1];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.durationSeconds).toBeCloseTo((audio.length * 8) / 128_000, 6);
  });

  it("rejects a false sync (an 0xFFFB inside data that doesn't line up with a next frame)", async () => {
    const audio = frames(MPEG1_HEADER, MPEG1_FRAME, 30);
    const bytes = [0x00, 0xff, 0xfb, 0x90, 0x00, ...zeros(50), ...audio];
    const result = await probeMp3(fetcher(bytes), bytes.length);
    expect(result.durationSeconds).toBeCloseTo((audio.length * 8) / 128_000, 6);
  });

  it("throws when there is no valid frame", async () => {
    const bytes = zeros(5000);
    await expect(probeMp3DurationSeconds(fetcher(bytes), bytes.length)).rejects.toThrow(Mp3DurationError);
  });

  it("reads ID3v2.4 CHAP chapters with UTF-8 and UTF-16 titles", async () => {
    const chap = (id: string, startMs: number, title: number[]) =>
      id3Frame(
        "CHAP",
        [...ascii(id), 0, ...u32be(startMs), ...u32be(startMs + 1000), ...u32be(0xffffffff), ...u32be(0xffffffff), ...id3Frame("TIT2", title)],
        4
      );
    const tag = id3v2([
      ...id3Frame("APIC", zeros(20_000)), // cover art must be skipped, not read
      ...chap("ch1", 0, [3, ...ascii("Opening")]),
      ...chap("ch2", 90_500, [1, 0xff, 0xfe, ...ascii("Two").flatMap((c) => [c, 0])]),
      ...chap("ch3", 200_000, [3, ...ascii("")]),
    ]);
    const audio = frames(MPEG1_HEADER, MPEG1_FRAME, 10);
    const bytes = [...tag, ...audio];
    const result = await probeMp3(fetcher(bytes), bytes.length, { chapters: true });
    expect(result.chapters).toEqual([
      { title: "Opening", startSeconds: 0 },
      { title: "Two", startSeconds: 90.5 },
      { title: "Chapter 3", startSeconds: 200 },
    ]);
  });

  it("reads ID3v2.3 CHAP chapters (plain big-endian frame sizes)", async () => {
    const tit2 = id3Frame("TIT2", [0, ...ascii("Only")], 3);
    const chap = id3Frame(
      "CHAP",
      [...ascii("c"), 0, ...u32be(5000), ...u32be(9000), ...u32be(0), ...u32be(0), ...tit2],
      3
    );
    const bytes = [...id3v2(chap, 3), ...frames(MPEG1_HEADER, MPEG1_FRAME, 10)];
    const result = await probeMp3(fetcher(bytes), bytes.length, { chapters: true });
    expect(result.chapters).toEqual([{ title: "Only", startSeconds: 5 }]);
  });

  it("returns null chapters when there are none", async () => {
    const bytes = frames(MPEG1_HEADER, MPEG1_FRAME, 10);
    const result = await probeMp3(fetcher(bytes), bytes.length, { chapters: true });
    expect(result.chapters).toBeNull();
  });
});
