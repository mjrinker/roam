import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { Mp4DurationError, probeMp4, probeMp4AudioTrack, probeMp4Codecs, probeMp4DurationSeconds, probeMp4VideoSize } from "./mp4-duration";

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

/** A version 0 tkhd carrying a picture size (16.16 fixed point at bytes 76 and 80 of the payload). */
function tkhdSized(trackId: number, width: number, height: number): number[] {
  return box("tkhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(trackId), ...zeros(4), ...u32be(0), ...zeros(8), ...zeros(2), ...zeros(2), ...zeros(2), ...zeros(2), ...zeros(36), ...u32be(width << 16), ...u32be(height << 16)]);
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
 * stsd payload: version(1)+flags(3), entry_count(4)=1, then one sample
 * entry: size(4)+format fourcc(4)+reserved(6)+data_reference_index(2).
 * `readStsdCodec` only reads the format fourcc of this first entry.
 */
function stsd(codec: string): number[] {
  const entry = [...u32be(16), ...fourcc(codec), ...zeros(6), 0, 1];
  return box("stsd", [0, 0, 0, 0, ...u32be(1), ...entry]);
}

function trakWithCodec(trackId: number, handler: string, timescale: number, codec: string): number[] {
  return box("trak", [
    ...tkhd(trackId),
    ...box("mdia", [...mdhd(timescale), ...hdlr(handler), ...box("minf", box("stbl", stsd(codec)))]),
  ]);
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

/**
 * Same shape as qtChapterFile, but the tref/chap reference sits on the
 * VIDEO track instead of the audio one — how HandBrake and similar video
 * muxers actually author it, as opposed to audiobook tools.
 */
function qtChapterFileVideoRef(opts: { samples: number[][] }) {
  const mdatHeaderLen = 8;
  const base = FTYP.length + mdatHeaderLen;
  const sizes = opts.samples.map((x) => x.length);
  const chunkOffsets = [base, base + sizes[0] + sizes[1]];
  const mdat = box("mdat", opts.samples.flat());

  const stts = box("stts", [0, 0, 0, 0, ...u32be(1), ...u32be(3), ...u32be(60_000)]);
  const stsc = box("stsc", [0, 0, 0, 0, ...u32be(2), ...u32be(1), ...u32be(2), ...u32be(1), ...u32be(2), ...u32be(1), ...u32be(1)]);
  const stsz = box("stsz", [0, 0, 0, 0, ...u32be(0), ...u32be(3), ...sizes.flatMap(u32be)]);
  const chunkBox = box("stco", [0, 0, 0, 0, ...u32be(2), ...chunkOffsets.flatMap(u32be)]);

  const videoTrak = box("trak", [
    ...tkhd(1),
    ...box("tref", box("chap", u32be(2))),
    ...box("mdia", [...mdhd(30_000), ...hdlr("vide"), ...box("minf", box("stbl", zeros(0)))]),
  ]);
  const textTrak = box("trak", [
    ...tkhd(2),
    ...box("mdia", [...mdhd(1000), ...hdlr("text"), ...box("minf", box("stbl", [...stts, ...stsc, ...stsz, ...chunkBox]))]),
  ]);
  const moov = box("moov", [...mvhdV0(1000, 180_000), ...videoTrak, ...textTrak]);
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

  it("finds a QuickTime chapter track referenced from the VIDEO track (HandBrake-style), not just audio", async () => {
    const { bytes, fetch } = qtChapterFileVideoRef({
      samples: [textSample(utf8("Cold Open")), textSample(utf8("Act One")), textSample(utf8("Act Two"))],
    });
    const result = await probeMp4(fetch, bytes.length, { chapters: true });
    expect(result.chaptersSource).toBe("qt");
    expect(result.chapters).toEqual([
      { title: "Cold Open", startSeconds: 0 },
      { title: "Act One", startSeconds: 60 },
      { title: "Act Two", startSeconds: 120 },
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
    expect(result).toEqual({
      durationSeconds: 42,
      chapters: null,
      chaptersSource: null,
      audioCodec: null,
      videoCodec: null,
      width: null,
      height: null,
      codecsProbed: true,
    });
  });
});

// ── Codecs ───────────────────────────────────────────────────────────────

describe("probeMp4 codecs", () => {
  it("reads the audio and video codecs even when chapters aren't requested", async () => {
    const moov = box("moov", [
      ...mvhdV0(1000, 60_000),
      ...trakWithCodec(1, "vide", 30_000, "avc1"),
      ...trakWithCodec(2, "soun", 44100, "mp4a"),
    ]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.videoCodec).toBe("avc1");
    expect(result.audioCodec).toBe("mp4a");
    expect(result.codecsProbed).toBe(true);
    expect(result.durationSeconds).toBe(60);
  });

  it("reports a problem codec (ac-3) the same way", async () => {
    const moov = box("moov", [...mvhdV0(1000, 60_000), ...trakWithCodec(1, "soun", 48000, "ac-3")]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.audioCodec).toBe("ac-3");
  });

  it("takes the FIRST track of each type by stream order, ignoring later ones", async () => {
    const moov = box("moov", [
      ...mvhdV0(1000, 60_000),
      ...trakWithCodec(1, "soun", 44100, "mp4a"),
      ...trakWithCodec(2, "soun", 48000, "ac-3"), // a second audio track — should be ignored
    ]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.audioCodec).toBe("mp4a");
  });

  it("returns null codecs (not an error) for a file with no matching track type", async () => {
    const moov = box("moov", [...mvhdV0(1000, 60_000), ...trakWithCodec(1, "vide", 30_000, "avc1")]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.audioCodec).toBeNull();
    expect(result.videoCodec).toBe("avc1");
    expect(result.codecsProbed).toBe(true);
  });

  it("marks codecsProbed false (without failing duration) when a track is malformed, and keeps reading later tracks", async () => {
    // A corrupt child box (declared size 4, below the 8-byte header minimum)
    // inside the first track's stbl — readBox throws walking into it.
    const malformedBox = [...u32be(4), ...fourcc("bad!")];
    const malformedTrak = box("trak", [
      ...tkhd(1),
      ...box("mdia", [...mdhd(1000), ...hdlr("vide"), ...box("minf", box("stbl", malformedBox))]),
    ]);
    const moov = box("moov", [...mvhdV0(1000, 60_000), ...malformedTrak, ...trakWithCodec(2, "soun", 44100, "mp4a")]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result.codecsProbed).toBe(false);
    expect(result.videoCodec).toBeNull(); // the malformed track never got to report one
    expect(result.audioCodec).toBe("mp4a"); // but the later, valid track still did
    expect(result.durationSeconds).toBe(60); // and the duration probe is unaffected
  });

  it("probeMp4Codecs (the backfill path) reads codecs alone, without needing a valid mvhd", async () => {
    const moov = box("moov", [...trakWithCodec(1, "soun", 44100, "ac-3")]); // no mvhd at all
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4Codecs(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result).toEqual({ audioCodec: "ac-3", videoCodec: null, width: null, height: null, codecsProbed: true });
  });

  it("reads the first video track's picture size (and the codecs call reports it too), ignoring audio tracks", async () => {
    const video = box("trak", [...tkhdSized(1, 1920, 800), ...box("mdia", [...mdhd(24000), ...hdlr("vide"), ...box("minf", box("stbl", stsd("avc1")))])]);
    const moov = box("moov", [...trakWithCodec(2, "soun", 48000, "mp4a"), ...video]);
    const bytes = [...FTYP, ...moov];
    expect(await probeMp4VideoSize(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length)).toEqual({ width: 1920, height: 800 });
    expect(await probeMp4Codecs(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length)).toEqual({ audioCodec: "mp4a", videoCodec: "avc1", width: 1920, height: 800, codecsProbed: true });
  });
  it("has no picture size for a file with no video track, or whose track says zero", async () => {
    const audioOnly = [...FTYP, ...box("moov", trakWithCodec(1, "soun", 44100, "mp4a"))];
    expect(await probeMp4VideoSize(fetcherFromSegments([{ offset: 0, bytes: audioOnly }]), audioOnly.length)).toBeNull();
    const zero = box("trak", [...tkhdSized(1, 0, 0), ...box("mdia", [...mdhd(24000), ...hdlr("vide"), ...box("minf", box("stbl", stsd("avc1")))])]);
    const bytes = [...FTYP, ...box("moov", zero)];
    expect(await probeMp4VideoSize(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length)).toBeNull();
  });

  it("probeMp4AudioTrack reads the first audio track's codec and declared channel count", async () => {
    // Audio sample entry: size, fourcc, reserved(6), dref(2), version/revision/vendor(8), channelcount(2), ...
    const entry = [...u32be(36), ...fourcc("ac-3"), ...zeros(6), 0, 1, ...zeros(8), 0, 6, 0, 16, ...zeros(4)];
    const audio = box("trak", [
      ...tkhd(2),
      ...box("mdia", [
        ...mdhd(48000),
        ...hdlr("soun"),
        ...box("minf", box("stbl", box("stsd", [0, 0, 0, 0, ...u32be(1), ...entry]))),
      ]),
    ]);
    const moov = box("moov", [...trakWithCodec(1, "vide", 1000, "avc1"), ...audio]);
    const bytes = [...FTYP, ...moov];
    const result = await probeMp4AudioTrack(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result).toEqual({ audioCodec: "ac-3", channels: 6 });
  });

  it("probeMp4AudioTrack reports null channels when the entry is too short, and nulls with no audio", async () => {
    const short = box("moov", [...trakWithCodec(1, "soun", 44100, "mp4a")]);
    const b1 = [...FTYP, ...short];
    expect(await probeMp4AudioTrack(fetcherFromSegments([{ offset: 0, bytes: b1 }]), b1.length)).toEqual({
      audioCodec: "mp4a",
      channels: null,
    });
    const none = box("moov", [...trakWithCodec(1, "vide", 1000, "avc1")]);
    const b2 = [...FTYP, ...none];
    expect(await probeMp4AudioTrack(fetcherFromSegments([{ offset: 0, bytes: b2 }]), b2.length)).toEqual({
      audioCodec: null,
      channels: null,
    });
  });
});

// ── Compressed headers (old QuickTime trailers) ──────────────────────────

/** A moov whose whole contents are one zlib-compressed `cmov`, as Apple's old .mov trailers have. */
function compressedMoov(inner: number[], algorithm = "zlib", corrupt = false): number[] {
  const z = Array.from(deflateSync(Uint8Array.from(inner)));
  if (corrupt) z.splice(2, z.length - 4);
  return box("moov", box("cmov", [...box("dcom", fourcc(algorithm)), ...box("cmvd", [...u32be(inner.length), ...z])]));
}

describe("probeMp4 with a compressed header (moov/cmov)", () => {
  const plain = box("moov", [...mvhdV0(600, 6000), ...trakWithCodec(1, "vide", 30_000, "avc1"), ...trakWithCodec(2, "soun", 44100, "mp4a")]);
  const mov = (moov: number[]) => {
    const mdat = box("mdat", new Array(5000).fill(1));
    return [...FTYP, ...mdat, ...moov]; // the header after the picture data, as in a file not yet optimised for streaming
  };

  it("reads the duration and codecs from the inflated header", async () => {
    const bytes = mov(compressedMoov(plain));
    const result = await probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length);
    expect(result).toMatchObject({ durationSeconds: 10, videoCodec: "avc1", audioCodec: "mp4a", codecsProbed: true });
  });
  it("works for the codec-only and picture-size reads too, and with chapters asked for", async () => {
    const bytes = mov(compressedMoov(plain));
    const fetch = fetcherFromSegments([{ offset: 0, bytes }]);
    expect(await probeMp4Codecs(fetch, bytes.length)).toMatchObject({ videoCodec: "avc1", audioCodec: "mp4a" });
    expect(await probeMp4AudioTrack(fetch, bytes.length)).toMatchObject({ audioCodec: "mp4a" });
    expect((await probeMp4(fetch, bytes.length, { chapters: true })).durationSeconds).toBe(10);
  });
  it("refuses a method it doesn't know, and a header that won't inflate, with a plain error", async () => {
    for (const bytes of [mov(compressedMoov(plain, "lzma")), mov(compressedMoov(plain, "zlib", true))]) {
      await expect(probeMp4(fetcherFromSegments([{ offset: 0, bytes }]), bytes.length)).rejects.toBeInstanceOf(Mp4DurationError);
    }
  });
});
