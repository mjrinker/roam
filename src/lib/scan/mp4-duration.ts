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
 * Big per-sample tables (the audio track's `stbl`) are never fetched, EXCEPT
 * for `stsd` (the sample description box) — small and fixed-size regardless
 * of file length, and read unconditionally on every probe (not gated behind
 * `opts.chapters` the way chapter-table reads are) because its first sample
 * entry's 4-byte type IS the codec fourcc (e.g. "mp4a" for AAC, "ac-3" for
 * Dolby) — this is how a file's audio/video codec is detected for browser
 * compatibility (see lib/scan/codec-support.ts). A failure reading `stsd`
 * never fails the surrounding duration probe; it's reported back distinctly
 * from "read fine, there's no such track" via `codecsProbed`.
 */

import { RangeReader, type ByteRangeFetcher } from "./range-reader";
import { cleanTagString } from "./tag-text";

export type { ByteRangeFetcher };

export interface Mp4Chapter {
  title: string;
  startSeconds: number;
}

export interface Mp4Probe {
  durationSeconds: number;
  chapters: Mp4Chapter[] | null;
  chaptersSource: "chpl" | "qt" | null;
  /** First audio/video track's codec fourcc, by stream index (matching ffmpeg's default `-map 0:a:0`/`-map 0:v:0`). Null if that track type doesn't exist. */
  audioCodec: string | null;
  videoCodec: string | null;
  /** False only if reading codecs hit an unexpected error (a malformed track) — distinct from a clean read that simply found no such track. Never affects durationSeconds. */
  codecsProbed: boolean;
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
  const moov = await findMoov(r, fileSizeBytes);
  return probeMoov(r, moov, !!opts.chapters);
}

/**
 * Locates the top-level `moov` atom. Factored out so the codec-only backfill
 * probe (`probeCodecsOnly`, for rows already probed before codec detection
 * existed) can reuse the exact same box-walk without duplicating it.
 */
async function findMoov(r: RangeReader, fileSizeBytes: number): Promise<Box> {
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset < fileSizeBytes; i++) {
    const box = await readBox(r, offset, fileSizeBytes, TOP_LEVEL_PREFETCH);
    if (!box) break;
    if (box.type === "moov") return box;
    offset = box.end;
  }
  throw new Mp4DurationError("No moov atom found within the box-walk budget");
}

/**
 * Codec-only backfill for a row that was already probed (duration known)
 * before codec detection existed — never touches duration/chapters, and its
 * failure/attempt bookkeeping is entirely separate from the main probe's
 * (see media-files.ts's probeCodecsOnly wrapper). Reuses the same
 * findMoov + per-track codec read as the main probe.
 */
export async function probeMp4Codecs(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number
): Promise<{ audioCodec: string | null; videoCodec: string | null; codecsProbed: boolean }> {
  const r = new RangeReader(fetchRange, fileSizeBytes);
  const moov = await findMoov(r, fileSizeBytes);
  return readCodecsFromTracks(r, moov);
}

/**
 * The first audio track's codec fourcc and declared channel count — what a
 * remux job needs to decide whether a file (or an existing copy of it) is
 * worth touching, without downloading anything. The channel count is the
 * sample entry's own field, so treat it as a hint for AC-3/E-AC-3.
 */
export async function probeMp4AudioTrack(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number
): Promise<{ audioCodec: string | null; channels: number | null }> {
  const r = new RangeReader(fetchRange, fileSizeBytes);
  const moov = await findMoov(r, fileSizeBytes);
  for await (const child of childBoxes(r, moov, MOOV_PREFETCH)) {
    if (child.type !== "trak") continue;
    const info = await readTrakInfo(r, child);
    if (info.handler === "soun") return { audioCodec: info.codec, channels: info.channelCount };
  }
  return { audioCodec: null, channels: null };
}

/**
 * Walks `moov`'s `trak` children looking only for the first audio and first
 * video track's codec (by stream index — matching ffmpeg's default
 * `-map 0:a:0`/`-map 0:v:0`), stopping as soon as both are found. A
 * malformed track marks `codecsProbed: false` for the whole result (distinct
 * from a track cleanly reporting no codec) but doesn't stop the walk — other
 * tracks are still tried.
 */
async function readCodecsFromTracks(
  r: RangeReader,
  moov: Box
): Promise<{ audioCodec: string | null; videoCodec: string | null; codecsProbed: boolean }> {
  let audioCodec: string | null = null;
  let videoCodec: string | null = null;
  let codecsProbed = true;
  for await (const child of childBoxes(r, moov, MOOV_PREFETCH)) {
    if (child.type !== "trak") continue;
    try {
      const info = await readTrakInfo(r, child);
      if (info.handler === "soun" && audioCodec === null) audioCodec = info.codec;
      if (info.handler === "vide" && videoCodec === null) videoCodec = info.codec;
    } catch {
      codecsProbed = false;
    }
    if (audioCodec !== null && videoCodec !== null) break;
  }
  return { audioCodec, videoCodec, codecsProbed };
}

// ── moov ─────────────────────────────────────────────────────────────────

interface TrakInfo {
  /** An audio sample entry's declared channel count (not always trustworthy for AC-3/E-AC-3); null if absent. */
  channelCount: number | null;
  trackId: number;
  chapterRefs: number[];
  handler: string;
  timescale: number;
  stbl: Box | null;
  codec: string | null;
}

async function probeMoov(r: RangeReader, moov: Box, wantChapters: boolean): Promise<Mp4Probe> {
  let movie: { timescale: number; duration: number } | null = null;
  const traks: TrakInfo[] = [];
  let chplChapters: Mp4Chapter[] | null = null;
  let audioCodec: string | null = null;
  let videoCodec: string | null = null;
  let codecsProbed = true;

  for await (const child of childBoxes(r, moov, MOOV_PREFETCH)) {
    if (child.type === "mvhd" && !movie) {
      movie = readTimescaleAndDuration(await r.read(child.contentStart, 32, 32), "mvhd");
    } else if (child.type === "trak") {
      // Codec detection runs unconditionally (see the module doc comment);
      // chapter-relevant track info is only kept when wantChapters. A
      // malformed track can't contribute either, but never stops the walk —
      // other tracks are still tried, and codecsProbed just records that
      // something went wrong somewhere, distinct from a clean "no track".
      try {
        const info = await readTrakInfo(r, child);
        if (wantChapters) traks.push(info);
        if (info.handler === "soun" && audioCodec === null) audioCodec = info.codec;
        if (info.handler === "vide" && videoCodec === null) videoCodec = info.codec;
      } catch {
        codecsProbed = false;
      }
      // Once both codecs are found and chapters aren't needed, there's
      // nothing further to learn from remaining tracks — stop early.
      if (!wantChapters && audioCodec !== null && videoCodec !== null && movie) break;
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
  const codecs = { audioCodec, videoCodec, codecsProbed };
  if (!wantChapters) return { durationSeconds, chapters: null, chaptersSource: null, ...codecs };

  if (chplChapters && chplChapters.length > 0) {
    return { durationSeconds, chapters: chplChapters, chaptersSource: "chpl", ...codecs };
  }

  try {
    const qt = await readQuickTimeChapters(r, traks);
    if (qt && qt.length > 0) return { durationSeconds, chapters: qt, chaptersSource: "qt", ...codecs };
  } catch {
    // fall through: no usable chapters
  }
  return { durationSeconds, chapters: null, chaptersSource: null, ...codecs };
}

// ── Descriptive tags (title, year, description, cover) ───────────────────

export interface Mp4Tags {
  title: string | null;
  /** ©ART, else the album artist (aART). */
  artist: string | null;
  album: string | null;
  year: number | null;
  description: string | null;
  /** The first embedded image that is a real JPEG/PNG within the size cap, else null. */
  cover: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array } | null;
}

const MAX_COVER_BYTES = 256 * 1024;
const MAX_TAG_TEXT = 2000;
const ATOM = (name: string) => "\u00a9" + name; // QuickTime/iTunes text atoms start with the © byte (0xA9)

function cleanTagText(bytes: Uint8Array, max = MAX_TAG_TEXT): string | null {
  return cleanTagString(new TextDecoder("utf-8").decode(bytes), max);
}

function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  return null;
}

/** The album artist is only a fallback for the track artist, whichever atom comes first. */
const albumArtists = new WeakMap<Mp4Tags, string>();

function applyText(tags: Mp4Tags, atom: string, text: string | null) {
  if (!text) return;
  if (atom === ATOM("nam") && tags.title === null) tags.title = cleanTagString(text, 300);
  else if (atom === ATOM("ART") && tags.artist === null) tags.artist = cleanTagString(text, 300);
  else if (atom === "aART" && !albumArtists.has(tags)) {
    const cleaned = cleanTagString(text, 300);
    if (cleaned) albumArtists.set(tags, cleaned);
  }
  else if (atom === ATOM("alb") && tags.album === null) tags.album = cleanTagString(text, 300);
  else if (atom === ATOM("day") && tags.year === null) {
    const y = Number(/^(\d{4})/.exec(text)?.[1]);
    if (y >= 1888 && y <= 2100) tags.year = y;
  } else if ((atom === "desc" || atom === "ldes") && tags.description === null) tags.description = text;
}

/** An iTunes-style `ilst` atom's `data` children: u8 version, u24 type flags, u32 locale, then the value. */
const tagsComplete = (t: Mp4Tags) =>
  t.title !== null && t.artist !== null && t.album !== null && t.year !== null && t.description !== null && t.cover !== null;
/** A file whose tags take more than this many atom reads to find is hostile or broken: stop. */
const MAX_TAG_ATOM_READS = 64;

async function readIlst(r: RangeReader, ilst: Box, tags: Mp4Tags) {
  let reads = 0;
  for await (const atom of childBoxes(r, ilst, MOOV_PREFETCH)) {
    if (tagsComplete(tags) || reads >= MAX_TAG_ATOM_READS) return;
    const wanted =
      atom.type === ATOM("nam") || atom.type === ATOM("ART") || atom.type === "aART" || atom.type === ATOM("alb") ||
      atom.type === ATOM("day") || atom.type === "desc" || atom.type === "ldes" || atom.type === "covr";
    if (!wanted) continue;
    for await (const data of childBoxes(r, atom, 4096)) {
      if (data.type !== "data") continue;
      if (++reads > MAX_TAG_ATOM_READS) return;
      const length = data.end - data.contentStart - 8;
      if (length <= 0) continue;
      if (atom.type === "covr") {
        if (tags.cover || length > MAX_COVER_BYTES) continue;
        const view = await r.read(data.contentStart + 8, length, length);
        if (view.byteLength < length) continue;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
        const contentType = imageType(bytes);
        if (contentType) tags.cover = { contentType, bytes };
      } else {
        const want = Math.min(length, MAX_TAG_TEXT * 4);
        const view = await r.read(data.contentStart + 8, want, want);
        applyText(tags, atom.type, cleanTagText(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
      }
    }
  }
}

/** `meta` is a full box in ISO files (4 bytes of version/flags first) but not in QuickTime ones; tell them apart by where `hdlr` sits. */
async function readMetaTags(r: RangeReader, meta: Box, tags: Mp4Tags) {
  const head = await r.read(meta.contentStart, 8, 8);
  const quickTime = head.byteLength >= 8 && fourcc(head, 4) === "hdlr";
  const children = { contentStart: quickTime ? meta.contentStart : meta.contentStart + 4, end: meta.end };
  for await (const child of childBoxes(r, children, MOOV_PREFETCH)) {
    if (child.type === "ilst") await readIlst(r, child, tags);
  }
}

async function readUdtaTags(r: RangeReader, udta: Box, tags: Mp4Tags) {
  for await (const child of childBoxes(r, udta, MOOV_PREFETCH)) {
    if (child.type === "meta") {
      await readMetaTags(r, child, tags);
    } else if (child.type === ATOM("nam") || child.type === ATOM("day") || child.type === ATOM("ART") || child.type === ATOM("alb")) {
      // QuickTime text atom: u16 length, u16 language, then the text.
      const length = child.end - child.contentStart - 4;
      if (length <= 0) continue;
      const want = Math.min(length, MAX_TAG_TEXT * 4);
      const view = await r.read(child.contentStart + 4, want, want);
      applyText(tags, child.type, cleanTagText(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
    }
  }
}

/**
 * A video file's own descriptive tags: title, year, description and cover image, from the iTunes
 * (`moov/udta/meta/ilst`) or QuickTime (`moov/udta/©nam`) layouts. Best effort: a malformed section
 * keeps whatever was read before it, and a file with no tags returns all nulls. Only a missing
 * `moov` or a failed Box read throws.
 */
export async function probeMp4Tags(fetchRange: ByteRangeFetcher, fileSizeBytes: number): Promise<Mp4Tags> {
  const r = new RangeReader(fetchRange, fileSizeBytes);
  const moov = await findMoov(r, fileSizeBytes);
  const tags: Mp4Tags = { title: null, artist: null, album: null, year: null, description: null, cover: null };
  try {
    for await (const child of childBoxes(r, moov, MOOV_PREFETCH)) {
      try {
        if (child.type === "udta") await readUdtaTags(r, child, tags);
        else if (child.type === "meta") await readMetaTags(r, child, tags);
      } catch {
        // This section is malformed; keep what earlier ones gave us.
      }
    }
  } catch {
    // The moov's own box list went bad partway; same.
  }
  tags.artist ??= albumArtists.get(tags) ?? null;
  return tags;
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

// ── Per-track info: codec (stsd) + QuickTime chapter text track ──────────

/**
 * stsd payload: version(1)+flags(3), entry_count(4), then the first sample
 * entry: size(4) + format fourcc(4) + ... The format IS the codec — "mp4a"
 * for AAC/MP3-in-MP4, "ac-3"/"ec-3" for Dolby, etc. Only the first entry is
 * read (matching a single codec per track, which is what ffmpeg's default
 * stream selection sees too).
 */
async function readStsdCodec(r: RangeReader, stbl: Box): Promise<{ codec: string | null; channelCount: number | null }> {
  for await (const child of childBoxes(r, stbl, 4096)) {
    if (child.type !== "stsd") continue;
    const view = await readPayload(r, child);
    if (view.byteLength < 16) break;
    // An audio sample entry puts its 16-bit channelcount 24 bytes past the entry's format fourcc (stsd payload offset 32).
    const channelCount = view.byteLength >= 34 ? view.getUint16(32, false) : null;
    return { codec: fourcc(view, 12), channelCount: channelCount || null };
  }
  return { codec: null, channelCount: null };
}

async function readTrakInfo(r: RangeReader, trak: Box): Promise<TrakInfo> {
  const info: TrakInfo = { trackId: 0, chapterRefs: [], handler: "", timescale: 0, stbl: null, codec: null, channelCount: null };

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
            if (n.type === "stbl") {
              info.stbl = n;
              // hdlr (above) always precedes minf within mdia in practice, so
              // info.handler is already set by the time this codec is used.
              const entry = await readStsdCodec(r, n);
              info.codec = entry.codec;
              info.channelCount = entry.channelCount;
            }
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
