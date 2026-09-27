/**
 * Determines an MP3 file's duration (and ID3v2 CHAP chapters) with a few
 * small byte-range reads. MP3 has no index box like MP4, so the duration
 * comes from, in order of preference:
 *   1. a Xing/Info header (frame count) in the first frame, or
 *   2. a VBRI header, or
 *   3. a constant-bitrate estimate: audio bytes * 8 / bitrate.
 * Only MPEG Layer III (what "mp3" means in practice) is supported.
 */

import { RangeReader, type ByteRangeFetcher } from "./range-reader";

export type { ByteRangeFetcher };

export class Mp3DurationError extends Error {}

export interface Mp3Chapter {
  title: string;
  startSeconds: number;
}

export interface Mp3Probe {
  durationSeconds: number;
  method: "xing" | "vbri" | "cbr";
  chapters: Mp3Chapter[] | null;
}

const SYNC_SEARCH_BYTES = 64 * 1024;
const MAX_ID3_TAGS = 4;
const MAX_ID3_FRAMES = 4096;
const MAX_CHAPTER_FRAME_BYTES = 64 * 1024;

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = {
  1: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  25: [11025, 12000, 8000], // MPEG-2.5
} as const;

interface FrameHeader {
  version: 1 | 2 | 25;
  bitrateKbps: number;
  sampleRate: number;
  padding: number;
  mono: boolean;
  frameLength: number;
  samplesPerFrame: number;
}

/** Parses a 4-byte MPEG audio frame header; null if it isn't a valid Layer III header. */
function parseFrameHeader(b0: number, b1: number, b2: number, b3: number): FrameHeader | null {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits !== 1) return null; // reserved version / not Layer III
  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const bitrateKbps = (version === 1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const padding = (b2 >> 1) & 1;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameLength = Math.floor(((version === 1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  return { version, bitrateKbps, sampleRate, padding, mono: ((b3 >> 6) & 3) === 3, frameLength, samplesPerFrame };
}

function syncsafe(view: DataView, at: number): number {
  return (
    ((view.getUint8(at) & 0x7f) << 21) |
    ((view.getUint8(at + 1) & 0x7f) << 14) |
    ((view.getUint8(at + 2) & 0x7f) << 7) |
    (view.getUint8(at + 3) & 0x7f)
  );
}

function ascii(view: DataView, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && at + i < view.byteLength; i++) out += String.fromCharCode(view.getUint8(at + i));
  return out;
}

// ── ID3v2 ────────────────────────────────────────────────────────────────

interface Id3Tag {
  version: number; // 3 or 4 matter here
  start: number;
  end: number; // first byte after the tag (and footer, if any)
  flags: number;
}

/** Reads consecutive ID3v2 tags at the start of the file. */
async function readId3Tags(r: RangeReader): Promise<{ tags: Id3Tag[]; audioStart: number }> {
  const tags: Id3Tag[] = [];
  let offset = 0;
  for (let i = 0; i < MAX_ID3_TAGS; i++) {
    const view = await r.read(offset, 10);
    if (view.byteLength < 10 || ascii(view, 0, 3) !== "ID3") break;
    const flags = view.getUint8(5);
    const size = syncsafe(view, 6);
    const end = offset + 10 + size + (flags & 0x10 ? 10 : 0);
    tags.push({ version: view.getUint8(3), start: offset, end, flags });
    offset = end;
  }
  return { tags, audioStart: offset };
}

function decodeId3Text(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const encoding = bytes[0];
  const body = bytes.subarray(1);
  let text: string;
  if (encoding === 1) {
    const le = body[0] === 0xff && body[1] === 0xfe;
    const be = body[0] === 0xfe && body[1] === 0xff;
    text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(le || be ? body.subarray(2) : body);
  } else if (encoding === 2) {
    text = new TextDecoder("utf-16be").decode(body);
  } else if (encoding === 3) {
    text = new TextDecoder("utf-8").decode(body);
  } else {
    text = new TextDecoder("latin1").decode(body);
  }
  return text.replace(/\0+$/, "").trim();
}

/** Walks a v2.3/v2.4 tag's frames, skipping bodies (cover art can be megabytes) except CHAP. */
async function readId3Chapters(r: RangeReader, tag: Id3Tag): Promise<Mp3Chapter[]> {
  if (tag.version !== 3 && tag.version !== 4) return [];
  const chapters: Mp3Chapter[] = [];

  let offset = tag.start + 10;
  const tagEnd = tag.end - (tag.flags & 0x10 ? 10 : 0);

  if (tag.flags & 0x40) {
    const ext = await r.read(offset, 4);
    if (ext.byteLength === 4) {
      offset += tag.version === 4 ? syncsafe(ext, 0) : 4 + ext.getUint32(0, false);
    }
  }

  for (let i = 0; i < MAX_ID3_FRAMES && offset + 10 <= tagEnd; i++) {
    const header = await r.read(offset, 10, 4096);
    if (header.byteLength < 10 || header.getUint8(0) === 0) break; // padding
    const id = ascii(header, 0, 4);
    const size = tag.version === 4 ? syncsafe(header, 4) : header.getUint32(4, false);
    const bodyStart = offset + 10;
    if (size < 0 || bodyStart + size > tagEnd) break;

    if (id === "CHAP" && size <= MAX_CHAPTER_FRAME_BYTES) {
      const view = await r.read(bodyStart, size);
      const body = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      const chapter = parseChapFrame(body, tag.version);
      if (chapter) chapters.push(chapter);
    }
    offset = bodyStart + size;
  }

  return chapters.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** CHAP: element id (NUL-terminated), start ms u32, end ms u32, offsets u32 x2, then subframes (TIT2 = title). */
function parseChapFrame(body: Uint8Array, version: number): Mp3Chapter | null {
  const nul = body.indexOf(0);
  if (nul < 0 || body.length < nul + 1 + 16) return null;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const startMs = view.getUint32(nul + 1, false);

  let title = "";
  let at = nul + 1 + 16;
  while (at + 10 <= body.length) {
    const id = ascii(view, at, 4);
    const size = version === 4 ? syncsafe(view, at + 4) : view.getUint32(at + 4, false);
    if (id.charCodeAt(0) === 0 || at + 10 + size > body.length) break;
    if (id === "TIT2") {
      title = decodeId3Text(body.subarray(at + 10, at + 10 + size));
      break;
    }
    at += 10 + size;
  }
  return { title, startSeconds: startMs / 1000 };
}

// ── Frame scanning ───────────────────────────────────────────────────────

/** Finds the first frame after `from`, requiring the next header to line up (or EOF) to reject false syncs. */
async function findFirstFrame(r: RangeReader, from: number): Promise<{ offset: number; header: FrameHeader }> {
  const window = await r.read(from, SYNC_SEARCH_BYTES, SYNC_SEARCH_BYTES + 4);
  const bytes = new Uint8Array(window.buffer, window.byteOffset, window.byteLength);

  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    const header = parseFrameHeader(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    if (!header) continue;

    const next = from + i + header.frameLength;
    if (next + 4 > r.size) return { offset: from + i, header }; // single-frame / tail case
    const nv = await r.read(next, 4);
    const nextHeader =
      nv.byteLength === 4 ? parseFrameHeader(nv.getUint8(0), nv.getUint8(1), nv.getUint8(2), nv.getUint8(3)) : null;
    if (nextHeader && nextHeader.version === header.version && nextHeader.sampleRate === header.sampleRate) {
      return { offset: from + i, header };
    }
  }
  throw new Mp3DurationError("No valid MP3 frame found");
}

/** Bytes of trailing non-audio data: an ID3v1 tag (128) and/or an APEv2 footer + its items. */
async function trailerBytes(r: RangeReader): Promise<number> {
  let trailer = 0;
  if (r.size >= 128) {
    const v1 = await r.read(r.size - 128, 3);
    if (ascii(v1, 0, 3) === "TAG") trailer += 128;
  }
  if (r.size >= trailer + 32) {
    const footer = await r.read(r.size - trailer - 32, 32);
    if (ascii(footer, 0, 8) === "APETAGEX") trailer += footer.getUint32(12, true) + (footer.getUint32(20, true) & 0x80000000 ? 32 : 0);
  }
  return trailer;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function probeMp3DurationSeconds(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number
): Promise<number> {
  return (await probeMp3(fetchRange, fileSizeBytes)).durationSeconds;
}

export async function probeMp3(
  fetchRange: ByteRangeFetcher,
  fileSizeBytes: number,
  opts: { chapters?: boolean } = {}
): Promise<Mp3Probe> {
  const r = new RangeReader(fetchRange, fileSizeBytes);
  const { tags, audioStart } = await readId3Tags(r);
  const { offset, header } = await findFirstFrame(r, audioStart);

  let chapters: Mp3Chapter[] | null = null;
  if (opts.chapters) {
    try {
      const all: Mp3Chapter[] = [];
      for (const tag of tags) all.push(...(await readId3Chapters(r, tag)));
      chapters = all.length > 0 ? all.map((c, i) => ({ ...c, title: c.title || `Chapter ${i + 1}` })) : null;
    } catch {
      chapters = null;
    }
  }

  // Xing/Info sits after the 4-byte header and the side info, whose size depends on version and channels.
  const sideInfo = header.version === 1 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17;
  const tagAt = offset + 4 + sideInfo;
  const tagView = await r.read(tagAt, 12);
  const marker = ascii(tagView, 0, 4);
  if ((marker === "Xing" || marker === "Info") && tagView.byteLength >= 12) {
    const flags = tagView.getUint32(4, false);
    if (flags & 1) {
      const frames = tagView.getUint32(8, false);
      if (frames > 0) {
        return { durationSeconds: (frames * header.samplesPerFrame) / header.sampleRate, method: "xing", chapters };
      }
    }
  }

  const vbriView = await r.read(offset + 4 + 32, 18);
  if (ascii(vbriView, 0, 4) === "VBRI" && vbriView.byteLength >= 18) {
    const frames = vbriView.getUint32(14, false);
    if (frames > 0) {
      return { durationSeconds: (frames * header.samplesPerFrame) / header.sampleRate, method: "vbri", chapters };
    }
  }

  // No VBR header: assume constant bitrate. (A VBR file with no header will
  // be off, which only affects the scrubber/total; playback advances on `ended`.)
  const audioBytes = fileSizeBytes - offset - (await trailerBytes(r));
  if (audioBytes <= 0) throw new Mp3DurationError("No audio data after MP3 header");
  return { durationSeconds: (audioBytes * 8) / (header.bitrateKbps * 1000), method: "cbr", chapters };
}
