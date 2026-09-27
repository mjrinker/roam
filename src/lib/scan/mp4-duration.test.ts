import { describe, expect, it } from "vitest";
import { Mp4DurationError, probeMp4, probeMp4DurationSeconds } from "./mp4-duration";

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

// ── Chapters ─────────────────────────────────────────────────────────────

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const zeros = (n: number) => new Array(n).fill(0);

function chplBox(chapters: { start100ns: number; title: string }[]): number[] {
  const entries = chapters.flatMap((c) => {
    const t = utf8(c.title);
    return [...u32be(Math.floor(c.start100ns / 2 ** 32)), ...u32be(c.start100ns % 2 ** 32), t.length, ...t];
  });
  return box("chpl", [1, 0, 0, 0, ...u32be(0), chapters.length, ...entries]);
}

function tkhd(trackId: number): number[] {
  return box("tkhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(trackId), ...zeros(60)]);
}
function mdhd(timescale: number): number[] {
  return box("mdhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(timescale), ...u32be(0), 0, 0, 0, 0]);
}
function hdlr(handler: string): number[] {
  return box("hdlr", [0, 0, 0, 0, ...u32be(0), ...fourcc(handler), ...zeros(12), 0]);
}
function textSample(bytes: number[]): number[] {
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}
function utf16be(s: string): number[] {
  return [0xfe, 0xff, ...Array.from(s).flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff])];
}

/**
 * ftyp, an mdat holding the chapter text samples, then moov at the END of the
 * file containing an audio trak (tref/chap -> track 2) and a text trak.
 * Chunk 1 holds two samples, chunk 2 holds one, exercising stsc.
 */
function qtChapterFile(opts: { co64?: boolean; samples: number[][] }) {
  const mdatHeaderLen = 8;
  const base = FTYP.length + mdatHeaderLen;
  const sizes = opts.samples.map((x) => x.length);
  const chunkOffsets = [base, base + sizes[0] + sizes[1]];
  const mdat = box("mdat", opts.samples.flat());

  const stts = box("stts", [0, 0, 0, 0, ...u32be(1), ...u32be(3), ...u32be(60_000)]);
  const stsc = box("stsc", [0, 0, 0, 0, ...u32be(2), ...u32be(1), ...u32be(2), ...u32be(1), ...u32be(2), ...u32be(1), ...u32be(1)]);
  const stsz = box("stsz", [0, 0, 0, 0, ...u32be(0), ...u32be(3), ...sizes.flatMap(u32be)]);
  const chunkBox = opts.co64
    ? box("co64", [0, 0, 0, 0, ...u32be(2), ...chunkOffsets.flatMap((o) => [...u32be(0), ...u32be(o)])])
    : box("stco", [0, 0, 0, 0, ...u32be(2), ...chunkOffsets.flatMap(u32be)]);

  const audioTrak = box("trak", [
    ...tkhd(1),
    ...box("tref", box("chap", u32be(2))),
    ...box("mdia", [...mdhd(44100), ...hdlr("soun"), ...box("minf", box("stbl", zeros(0)))]),
  ]);
  const textTrak = box("trak", [
    ...tkhd(2),
    ...box("mdia", [...mdhd(1000), ...hdlr("text"), ...box("minf", box("stbl", [...stts, ...stsc, ...stsz, ...chunkBox]))]),
  ]);
  const moov = box("moov", [...mvhdV0(1000, 180_000), ...audioTrak, ...textTrak]);
  const bytes = [...FTYP, ...mdat, ...moov];
  return { bytes, fetch: fetcherFromSegments([{ offset: 0, bytes }]) };
}

describe("probeMp4 chapters", () => {
  it("returns no chapters unless asked", async () => {
    const moov = box("moov", [...mvhdV0(1000, 60_000), ...box("udta", chplBox([{ start100ns: 0, title: "One" }]))]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.chapters).toBeNull();
    expect(result.durationSeconds).toBe(60);
  });

  it("reads Nero chpl chapters", async () => {
    const udta = box("udta", chplBox([
      { start100ns: 0, title: "Opening Credits" },
      { start100ns: 125 * 1e7, title: "Chapter 1: Café" },
      { start100ns: 2 ** 32 + 5 * 1e7, title: "Big offset" },
    ]));
    const moov = box("moov", [...mvhdV0(1000, 9_000_000), ...udta]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length, { chapters: true });
    expect(result.chaptersSource).toBe("chpl");
    expect(result.chapters).toEqual([
      { title: "Opening Credits", startSeconds: 0 },
      { title: "Chapter 1: Café", startSeconds: 125 },
      { title: "Big offset", startSeconds: (2 ** 32 + 5 * 1e7) / 1e7 },
    ]);
  });

  it("reads a QuickTime chapter text track (stco, multi-sample chunks, moov at end)", async () => {
    const { bytes, fetch } = qtChapterFile({
      samples: [textSample(utf8("Intro")), textSample(utf8("Chapter 1")), textSample(utf8("Ünïcode ✓"))],
    });
    const result = await probeMp4(fetch, bytes.length, { chapters: true });
    expect(result.chaptersSource).toBe("qt");
    expect(result.durationSeconds).toBe(180);
    expect(result.chapters).toEqual([
      { title: "Intro", startSeconds: 0 },
      { title: "Chapter 1", startSeconds: 60 },
      { title: "Ünïcode ✓", startSeconds: 120 },
    ]);
  });

  it("handles co64 chunk offsets and UTF-16 (BOM) titles", async () => {
    const { bytes, fetch } = qtChapterFile({
      co64: true,
      samples: [textSample(utf16be("Prolog")), textSample(utf8("Two")), textSample(utf8("Three"))],
    });
    const result = await probeMp4(fetch, bytes.length, { chapters: true });
    expect(result.chapters?.map((c) => c.title)).toEqual(["Prolog", "Two", "Three"]);
  });

  it("never reads the audio track's sample tables", async () => {
    // The audio trak's stbl is declared enormous; the fetcher zero-fills
    // anywhere unbacked, so descending into it would produce garbage or hang.
    const { bytes } = qtChapterFile({ samples: [textSample(utf8("A")), textSample(utf8("B")), textSample(utf8("C"))] });
    const seen: [number, number][] = [];
    const inner = fetcherFromSegments([{ offset: 0, bytes }]);
    const result = await probeMp4(
      async (a, b) => {
        seen.push([a, b]);
        return inner(a, b);
      },
      bytes.length,
      { chapters: true }
    );
    expect(result.chapters).toHaveLength(3);
    expect(seen.length).toBeLessThan(25);
  });

  it("reports no chapters (but still the duration) for a file without any", async () => {
    const moov = box("moov", [...mvhdV0(1000, 42_000), ...box("udta", box("meta", zeros(8)))]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length, { chapters: true });
    expect(result).toEqual({ durationSeconds: 42, chapters: null, chaptersSource: null });
  });
});
