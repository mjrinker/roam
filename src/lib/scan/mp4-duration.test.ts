import { describe, expect, it } from "vitest";
import { Mp4DurationError, probeMp4DurationSeconds } from "./mp4-duration";

// ── Minimal MP4 box builders ────────────────────────────────────────────
// Just enough of the ISO BMFF box format to exercise the real parser
// against real bytes, rather than trusting the byte-offset math by eye.

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function fourcc(s: string): number[] {
  return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
}
function box(type: string, payload: number[]): number[] {
  return [...u32be(8 + payload.length), ...fourcc(type), ...payload];
}
/** A box using the 64-bit "largesize" encoding (32-bit size field == 1). */
function largeBox(type: string, payload: number[]): number[] {
  const totalSize = 16 + payload.length; // size(4)+type(4)+largesize(8)+payload
  return [
    ...u32be(1),
    ...fourcc(type),
    ...u32be(0),
    ...u32be(totalSize),
    ...payload,
  ];
}

function mvhdV0(timescale: number, duration: number): number[] {
  return box("mvhd", [
    0, 0, 0, 0, // version(1) + flags(3)
    ...u32be(0), // creation_time
    ...u32be(0), // modification_time
    ...u32be(timescale),
    ...u32be(duration),
    ...new Array(80).fill(0), // rate/volume/reserved/matrix/pre_defined/next_track_id
  ]);
}

function mvhdV1(timescale: number, durationHi: number, durationLo: number): number[] {
  return box("mvhd", [
    1, 0, 0, 0, // version(1) + flags(3)
    ...u32be(0),
    ...u32be(0), // creation_time (8 bytes)
    ...u32be(0),
    ...u32be(0), // modification_time (8 bytes)
    ...u32be(timescale),
    ...u32be(durationHi),
    ...u32be(durationLo),
    ...new Array(80).fill(0),
  ]);
}

const FTYP = box("ftyp", [...fourcc("isom"), ...u32be(0), ...fourcc("isom")]);

/** Serves byte ranges from a set of named segments placed at known offsets;
 * anything outside those segments reads as zero-filled bytes (a box type
 * the parser is expected to skip over via arithmetic, never actually read). */
function fetcherFromSegments(segments: { offset: number; bytes: number[] }[]) {
  return async (start: number, end: number): Promise<ArrayBuffer> => {
    const len = end - start + 1;
    const out = new Uint8Array(len);
    for (const seg of segments) {
      const segEnd = seg.offset + seg.bytes.length;
      const overlapStart = Math.max(start, seg.offset);
      const overlapEnd = Math.min(end + 1, segEnd);
      for (let i = overlapStart; i < overlapEnd; i++) {
        out[i - start] = seg.bytes[i - seg.offset];
      }
    }
    return out.buffer;
  };
}

describe("probeMp4DurationSeconds", () => {
  it("reads a version-0 mvhd (moov right after ftyp — faststart layout)", async () => {
    const moov = box("moov", mvhdV0(1000, 5400_000)); // 5400s at a 1000 timescale
    const bytes = [...FTYP, ...moov];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    const seconds = await probeMp4DurationSeconds(fetch, bytes.length);
    expect(seconds).toBe(5400);
  });

  it("reads a version-1 mvhd (64-bit creation/modification/duration)", async () => {
    // duration = 1*2^32 + 234, timescale = 1000 -> exercises the hi/lo word math.
    const moov = box("moov", mvhdV1(1000, 1, 234));
    const bytes = [...FTYP, ...moov];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    const seconds = await probeMp4DurationSeconds(fetch, bytes.length);
    expect(seconds).toBeCloseTo((2 ** 32 + 234) / 1000, 6);
  });

  it("finds mvhd when it isn't moov's first child box", async () => {
    const filler = box("iods", [0, 0, 0, 0]);
    const moov = box("moov", [...filler, ...mvhdV0(600, 3600)]);
    const bytes = [...FTYP, ...moov];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    const seconds = await probeMp4DurationSeconds(fetch, bytes.length);
    expect(seconds).toBe(6); // 3600 / 600
  });

  it("skips a huge mdat (moov-at-end layout) without reading its payload", async () => {
    // A non-faststart file: ftyp, then a huge mdat, then moov at the very
    // end. The parser must jump past mdat using its declared size alone —
    // never touch a byte inside it (the fetcher would return zeros there,
    // which would corrupt the mvhd parse if it were ever read).
    const mdatSize = 5_000_000;
    const mdatHeader = [...u32be(mdatSize), ...fourcc("mdat")];
    const moovOffset = FTYP.length + mdatSize;
    const moov = box("moov", mvhdV0(48000, 2_400_000)); // 50s at 48kHz-style timescale

    const fetch = fetcherFromSegments([
      { offset: 0, bytes: FTYP },
      { offset: FTYP.length, bytes: mdatHeader },
      { offset: moovOffset, bytes: moov },
    ]);
    const seconds = await probeMp4DurationSeconds(fetch, moovOffset + moov.length);
    expect(seconds).toBe(50);
  });

  it("handles a moov box using the 64-bit largesize encoding", async () => {
    const moov = largeBox("moov", mvhdV0(1000, 90_000));
    const bytes = [...FTYP, ...moov];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    const seconds = await probeMp4DurationSeconds(fetch, bytes.length);
    expect(seconds).toBe(90);
  });

  it("throws when there's no moov atom at all", async () => {
    const mdat = box("mdat", [1, 2, 3, 4]);
    const bytes = [...FTYP, ...mdat];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    await expect(probeMp4DurationSeconds(fetch, bytes.length)).rejects.toThrow(
      Mp4DurationError
    );
  });

  it("throws when moov has no mvhd child", async () => {
    const moov = box("moov", box("iods", [0, 0, 0, 0]));
    const bytes = [...FTYP, ...moov];
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    await expect(probeMp4DurationSeconds(fetch, bytes.length)).rejects.toThrow(
      Mp4DurationError
    );
  });
});
