/**
 * Reads an MP4/M4B/MOV file's duration (and, for audiobooks, its chapter
 * list) by walking the box (atom) structure with small byte-range fetches
 * instead of downloading the file. This is what lets the scanner compute a
 * segmented title's exact global timeline (see media_files.duration_ms in
 * the schema) cheaply, without ffmpeg.
 *
 * MP4 box layout: [size:u32][type:4cc]([largesize:u64] if size===1)[payload]
 * `moov` is a container box; `mvhd` holds the overall timescale + duration.
 *
 * Chapters come from either of the two places audiobook tools put them:
 *   - `moov/udta/chpl`: Nero-style chapter list (mp4chaps, most taggers)
 *   - a QuickTime chapter text track (`tref/chap` on the audio track pointing
 *     at a text `trak`), which is all that ffmpeg-made m4bs carry.
 * Big per-sample tables (the audio track's `stbl`) are never fetched.
 */

import { RangeReader, type ByteRangeFetcher } from "./range-reader";

export type { ByteRangeFetcher };

export interface Mp4Chapter {
  title: string;
  startSeconds: number;
}

export interface Mp4Probe {
  durationSeconds: number;
  chapters: Mp4Chapter[] | null;
  chaptersSource: "chpl" | "qt" | null;
}

const TOP_LEVEL_PREFETCH = 16; // enough for size(4)+type(4)+largesize(8)
const MOOV_PREFETCH = 64 * 1024; // moov's children are read from one window where possible
const MAX_TOP_LEVEL_BOXES = 128; // guards against malformed/adversarial files
const MAX_CHILD_BOXES = 256;
const MAX_TABLE_BYTES = 512 * 1024; // cap on any single sample table we read
const MAX_CHAPTERS = 2000;

export class Mp4DurationError extends Error {}

// ── Box walking ──────────────────────────────────────────────────────────

interface Box {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  );
}

async function readBox(
  r: RangeReader,
  offset: number,
  parentEnd: number,
  prefetch: number
): Promise<Box | null> {
  if (offset + 8 > parentEnd) return null;
  const view = await r.read(offset, 16, prefetch);
  if (view.byteLength < 8) {
    throw new Mp4DurationError("Unexpected end of file while reading box header");
  }

  let size = view.getUint32(0, false);
  const type = fourcc(view, 4);
  let headerLen = 8;

  if (size === 1) {
    // 64-bit "largesize" follows the type when the 32-bit size is this sentinel.
    if (view.byteLength < 16) throw new Mp4DurationError("Truncated 64-bit box size");
    size = view.getUint32(8, false) * 2 ** 32 + view.getUint32(12, false);
    headerLen = 16;
  } else if (size === 0) {
    // Box extends to the end of its parent (only valid for the last box).
    size = parentEnd - offset;
  }

  if (size < headerLen) throw new Mp4DurationError(`Invalid box size at offset ${offset}`);
  return { type, start: offset, contentStart: offset + headerLen, end: Math.min(offset + size, parentEnd) };
}

async function* childBoxes(
  r: RangeReader,
  parent: { contentStart: number; end: number },
  prefetch: number
): AsyncGenerator<Box> {
  let offset = parent.contentStart;
  for (let i = 0; i < MAX_CHILD_BOXES; i++) {
    const box = await readBox(r, offset, parent.end, prefetch);
    if (!box) return;
    yield box;
    offset = box.end;
  }
}

/** A box's payload (after its header), capped at MAX_TABLE_BYTES. */
async function readPayload(r: RangeReader, box: Box, extraPrefetch = 0): Promise<DataView> {
  const length = Math.min(box.end - box.contentStart, MAX_TABLE_BYTES);
  return r.read(box.contentStart, length, length + extraPrefetch);
}

// ── mvhd / mdhd ──────────────────────────────────────────────────────────

/** mvhd and mdhd share a layout: v0 timescale at +12 / duration at +16, v1 at +20 / +24 (u64). */
function readTimescaleAndDuration(view: DataView, what: string): { timescale: number; duration: number } {
  if (view.byteLength < 20) throw new Mp4DurationError(`${what} is truncated`);
  const version = view.getUint8(0);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (view.byteLength < 32) throw new Mp4DurationError(`${what} is truncated`);
    timescale = view.getUint32(20, false);
    duration = view.getUint32(24, false) * 2 ** 32 + view.getUint32(28, false);
  } else {
    timescale = view.getUint32(12, false);
    duration = view.getUint32(16, false);
  }
  if (!timescale) throw new Mp4DurationError(`${what} timescale is zero`);
  return { timescale, duration };
}

// ── Public API ───────────────────────────────────────────────────────────

/** Duration in seconds (fractional). */
export async function probeMp4DurationSeconds(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number
): Promise<number> {
  return (await probeMp4(fetchRange, fileSizeBytes)).durationSeconds;
}

/**
 * Duration, plus chapters when `opts.chapters` is set. Chapter parsing is
 * best-effort: a malformed chapter structure yields `chapters: null`, never a
 * failed probe, since the duration is what playback depends on.
 */
export async function probeMp4(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number,
  opts: { chapters?: boolean } = {}
): Promise<Mp4Probe> {
  const r = new RangeReader(fetchRange, fileSizeBytes);

  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset < fileSizeBytes; i++) {
    const box = await readBox(r, offset, fileSizeBytes, TOP_LEVEL_PREFETCH);
    if (!box) break;
    if (box.type === "moov") return probeMoov(r, box, !!opts.chapters);
    offset = box.end;
  }

  throw new Mp4DurationError("No moov atom found within the box-walk budget");
}

// ── moov ─────────────────────────────────────────────────────────────────

interface TrakInfo {
  trackId: number;
  chapterRefs: number[];
  handler: string;
  timescale: number;
  stbl: Box | null;
}

async function probeMoov(r: RangeReader, moov: Box, wantChapters: boolean): Promise<Mp4Probe> {
  let movie: { timescale: number; duration: number } | null = null;
  const traks: TrakInfo[] = [];
  let chplChapters: Mp4Chapter[] | null = null;

  for await (const child of childBoxes(r, moov, MOOV_PREFETCH)) {
    if (child.type === "mvhd" && !movie) {
      movie = readTimescaleAndDuration(await r.read(child.contentStart, 32, 32), "mvhd");
      if (!wantChapters) break;
    } else if (wantChapters && child.type === "trak") {
      try {
        traks.push(await readTrakInfo(r, child));
      } catch {
        // an unreadable track just can't contribute chapters
      }
    } else if (wantChapters && child.type === "udta" && !chplChapters) {
      try {
        chplChapters = await readChpl(r, child);
      } catch {
        chplChapters = null;
      }
    }
  }

  if (!movie) throw new Mp4DurationError("mvhd atom not found within moov search window");
  const durationSeconds = movie.duration / movie.timescale;
  if (!wantChapters) return { durationSeconds, chapters: null, chaptersSource: null };

  if (chplChapters && chplChapters.length > 0) {
    return { durationSeconds, chapters: chplChapters, chaptersSource: "chpl" };
  }

  try {
    const qt = await readQuickTimeChapters(r, traks);
    if (qt && qt.length > 0) return { durationSeconds, chapters: qt, chaptersSource: "qt" };
  } catch {
    // fall through: no usable chapters
  }
  return { durationSeconds, chapters: null, chaptersSource: null };
}

// ── chpl (Nero chapters) ─────────────────────────────────────────────────

/**
 * chpl payload (per ffmpeg's mov_read_chpl): version u8, flags u24, u32
 * reserved if version >= 1, count u8, then per chapter: start u64 in 100ns
 * units, title length u8, title bytes (UTF-8).
 */
async function readChpl(r: RangeReader, udta: Box): Promise<Mp4Chapter[] | null> {
  for await (const child of childBoxes(r, udta, 4096)) {
    if (child.type !== "chpl") continue;
    const view = await readPayload(r, child);
    if (view.byteLength < 5) return null;

    let at = 4;
    if (view.getUint8(0) >= 1) at += 4;
    const count = view.getUint8(at);
    at += 1;

    const decoder = new TextDecoder("utf-8");
    const chapters: Mp4Chapter[] = [];
    for (let i = 0; i < count; i++) {
      if (at + 9 > view.byteLength) break;
      const start100ns = view.getUint32(at, false) * 2 ** 32 + view.getUint32(at + 4, false);
      const titleLen = view.getUint8(at + 8);
      at += 9;
      if (at + titleLen > view.byteLength) break;
      const title = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + at, titleLen)).trim();
      at += titleLen;
      chapters.push({ title: title || `Chapter ${i + 1}`, startSeconds: start100ns / 1e7 });
    }
    return chapters.length > 0 ? chapters : null;
  }
  return null;
}

// ── QuickTime chapter text track ─────────────────────────────────────────

async function readTrakInfo(r: RangeReader, trak: Box): Promise<TrakInfo> {
  const info: TrakInfo = { trackId: 0, chapterRefs: [], handler: "", timescale: 0, stbl: null };

  for await (const child of childBoxes(r, trak, 4096)) {
    if (child.type === "tkhd") {
      const view = await r.read(child.contentStart, 24, 24);
      info.trackId = view.getUint32(view.getUint8(0) === 1 ? 20 : 12, false);
    } else if (child.type === "tref") {
      for await (const ref of childBoxes(r, child, 256)) {
        if (ref.type !== "chap") continue;
        const view = await r.read(ref.contentStart, ref.end - ref.contentStart, 256);
        for (let at = 0; at + 4 <= view.byteLength; at += 4) info.chapterRefs.push(view.getUint32(at, false));
      }
    } else if (child.type === "mdia") {
      for await (const m of childBoxes(r, child, 4096)) {
        if (m.type === "mdhd") {
          info.timescale = readTimescaleAndDuration(await r.read(m.contentStart, 32, 32), "mdhd").timescale;
        } else if (m.type === "hdlr") {
          const view = await r.read(m.contentStart, 12, 12);
          if (view.byteLength >= 12) info.handler = fourcc(view, 8);
        } else if (m.type === "minf") {
          for await (const n of childBoxes(r, m, 4096)) {
            if (n.type === "stbl") info.stbl = n;
          }
        }
      }
    }
  }
  return info;
}

async function readQuickTimeChapters(r: RangeReader, traks: TrakInfo[]): Promise<Mp4Chapter[] | null> {
  // Audio muxers put the chapter reference on the audio ("soun") track, but
  // video muxers (e.g. HandBrake) put it on the video ("vide") track — a
  // multi-episode video file's embedded chapters (used to snap the
  // episode-split estimate to a real scene boundary) would otherwise never
  // be found.
  const refs = traks
    .filter((t) => t.handler === "soun" || t.handler === "vide")
    .flatMap((t) => t.chapterRefs);
  const track =
    traks.find((t) => refs.includes(t.trackId)) ?? traks.find((t) => t.handler === "text");
  if (!track?.stbl || !track.timescale) return null;

  const tables: {
    stts?: DataView;
    stsc?: DataView;
    stsz?: DataView;
    stco?: DataView;
    co64?: DataView;
  } = {};
  for await (const child of childBoxes(r, track.stbl, 4096)) {
    if (child.type === "stts" || child.type === "stsc" || child.type === "stsz" || child.type === "stco" || child.type === "co64") {
      // Copy: the reader's window is reused by later reads.
      const view = await readPayload(r, child);
      const copy = new Uint8Array(view.byteLength);
      copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      tables[child.type] = new DataView(copy.buffer);
    }
  }
  const { stts, stsc, stsz } = tables;
  if (!stts || !stsc || !stsz || !(tables.stco || tables.co64)) return null;

  // Sample sizes.
  const defaultSize = stsz.getUint32(4, false);
  const sampleCount = Math.min(stsz.getUint32(8, false), MAX_CHAPTERS);
  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(defaultSize || stsz.getUint32(12 + i * 4, false));
  }

  // Sample start times, from time-to-sample runs.
  const starts: number[] = [];
  const sttsEntries = stts.getUint32(4, false);
  let time = 0;
  for (let e = 0; e < sttsEntries && starts.length < sampleCount; e++) {
    const count = stts.getUint32(8 + e * 8, false);
    const delta = stts.getUint32(12 + e * 8, false);
    for (let k = 0; k < count && starts.length < sampleCount; k++) {
      starts.push(time);
      time += delta;
    }
  }

  // Sample file offsets, from sample-to-chunk runs + chunk offsets.
  const chunkOffsets: number[] = [];
  if (tables.co64) {
    const n = tables.co64.getUint32(4, false);
    for (let i = 0; i < n; i++) {
      chunkOffsets.push(tables.co64.getUint32(8 + i * 8, false) * 2 ** 32 + tables.co64.getUint32(12 + i * 8, false));
    }
  } else if (tables.stco) {
    const n = tables.stco.getUint32(4, false);
    for (let i = 0; i < n; i++) chunkOffsets.push(tables.stco.getUint32(8 + i * 4, false));
  }
  const stscEntries = stsc.getUint32(4, false);
  const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let e = 0; e < stscEntries; e++) {
    runs.push({
      firstChunk: stsc.getUint32(8 + e * 12, false),
      samplesPerChunk: stsc.getUint32(12 + e * 12, false),
    });
  }

  const offsets: number[] = [];
  for (let c = 0; c < chunkOffsets.length && offsets.length < sampleCount; c++) {
    const chunkNumber = c + 1;
    let perChunk = 0;
    for (const run of runs) if (run.firstChunk <= chunkNumber) perChunk = run.samplesPerChunk;
    let at = chunkOffsets[c];
    for (let k = 0; k < perChunk && offsets.length < sampleCount; k++) {
      offsets.push(at);
      at += sizes[offsets.length - 1];
    }
  }

  const count = Math.min(sampleCount, starts.length, offsets.length);
  const chapters: Mp4Chapter[] = [];
  for (let i = 0; i < count; i++) {
    const view = await r.read(offsets[i], sizes[i], Math.max(sizes[i], 32 * 1024));
    chapters.push({
      title: decodeChapterSample(view) || `Chapter ${i + 1}`,
      startSeconds: starts[i] / track.timescale,
    });
  }
  return chapters;
}

/** A QuickTime text sample: u16 length, then the text (UTF-8, or UTF-16 with a BOM). */
function decodeChapterSample(view: DataView): string {
  if (view.byteLength < 2) return "";
  const length = Math.min(view.getUint16(0, false), view.byteLength - 2);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + 2, length);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2)).trim();
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2)).trim();
  }
  return new TextDecoder("utf-8").decode(bytes).trim();
}
