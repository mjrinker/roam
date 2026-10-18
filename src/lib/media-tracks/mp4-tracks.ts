/**
 * Reads the audio and subtitle tracks inside an MP4 over byte-range requests, and cuts one audio track out as short fragmented-MP4 pieces
 * that a browser can play through Media Source Extensions. Browsers play only the first audio track of an MP4 and show none of its text
 * tracks, so Roam's player asks for these pieces to let a viewer choose another language, and for the subtitle cues as plain text.
 *
 * Nothing here downloads the whole file: the header (`moov`) is read once, and then only the byte ranges of the samples wanted. The
 * network is injected (a byte-range fetcher), so everything is tested against a real file with no server.
 */
import type { ByteRangeFetcher } from "@/lib/scan/range-reader";

export type { ByteRangeFetcher };

const MAX_MOOV_BYTES = 48 * 1024 * 1024;
const MAX_TOP_LEVEL_HOPS = 64;
/** The longest a piece of audio runs; also what the player asks for as one request. */
export const FRAGMENT_SECONDS = 20;

export class TracksError extends Error {}

// ── Reading boxes ────────────────────────────────────────────────────────

interface Box {
  type: string;
  start: number;
  /** First byte after the header. */
  body: number;
  end: number;
}

const text4 = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

function boxesIn(v: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < 4096) {
    let size = v.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    out.push({ type: text4(v, at + 4), start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (v: DataView, box: Box, type: string) => boxesIn(v, box.body, box.end).find((b) => b.type === type);

/** The whole `moov` box (header and all) as bytes, wherever it sits in the file. */
export async function fetchMoov(fetchRange: ByteRangeFetcher, fileSize: number): Promise<DataView> {
  let at = 0;
  for (let hop = 0; hop < MAX_TOP_LEVEL_HOPS && at + 8 <= fileSize; hop++) {
    const head = new DataView(await fetchRange(at, Math.min(at + 15, fileSize - 1)));
    if (head.byteLength < 8) break;
    let size = head.getUint32(0);
    const type = text4(head, 4);
    if (size === 1 && head.byteLength >= 16) size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
    else if (size === 0) size = fileSize - at;
    if (size < 8) break;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) throw new TracksError("This file's header is too large to read.");
      const all = await fetchRange(at, at + size - 1);
      return new DataView(all);
    }
    at += size;
  }
  throw new TracksError("No header found in this file.");
}

// ── Tracks ───────────────────────────────────────────────────────────────

export interface Mp4Track {
  trackId: number;
  handler: string;
  /** The sample entry's fourcc: "mp4a", "ac-3", "tx3g"... */
  codec: string;
  /** ISO 639-2 ("eng"), or "und". */
  language: string;
  /** The track's own name (the handler name), when it has a useful one. */
  name: string;
  timescale: number;
  channels: number;
  sampleRate: number;
  /** Everything needed to find a sample: decoded lazily by {@link samplesOf}. */
  tables: { stts: DataView; stsz: DataView; stsc: DataView; stco: DataView; co64: boolean; stsd: Uint8Array };
}

function languageOf(code: number): string {
  if (code === 0) return "und";
  const chars = [(code >> 10) & 31, (code >> 5) & 31, code & 31].map((n) => String.fromCharCode(n + 0x60));
  return chars.join("");
}

function slice(v: DataView, box: Box): DataView {
  return new DataView(v.buffer, v.byteOffset + box.body, box.end - box.body);
}

/** Every track in a `moov` (video included, which only gets what describes it, never its sample tables). */
export function readTracks(moov: DataView): { tracks: Mp4Track[]; movieTimescale: number } {
  const top = boxesIn(moov, 0, moov.byteLength).find((b) => b.type === "moov");
  if (!top) throw new TracksError("No header found in this file.");
  const mvhd = child(moov, top, "mvhd");
  let movieTimescale = 1000;
  if (mvhd) movieTimescale = moov.getUint32(mvhd.body + (moov.getUint8(mvhd.body) === 1 ? 20 : 12)) || 1000;
  const tracks: Mp4Track[] = [];
  for (const trak of boxesIn(moov, top.body, top.end).filter((b) => b.type === "trak")) {
    try {
      const tkhd = child(moov, trak, "tkhd")!;
      const mdia = child(moov, trak, "mdia")!;
      const mdhd = child(moov, mdia, "mdhd")!;
      const hdlr = child(moov, mdia, "hdlr")!;
      const stbl = child(moov, child(moov, mdia, "minf")!, "stbl")!;
      const v1 = moov.getUint8(tkhd.body) === 1;
      const trackId = moov.getUint32(tkhd.body + (v1 ? 20 : 12));
      const md1 = moov.getUint8(mdhd.body) === 1;
      const timescale = moov.getUint32(mdhd.body + (md1 ? 20 : 12));
      const language = languageOf(moov.getUint16(mdhd.body + (md1 ? 32 : 20)));
      const handler = text4(moov, hdlr.body + 8);
      // The handler's name is a counted or zero-ended string after 24 bytes; ffmpeg's default names ("SoundHandler") say nothing.
      const rawName = new TextDecoder().decode(new Uint8Array(moov.buffer, moov.byteOffset + hdlr.body + 24, Math.max(0, hdlr.end - hdlr.body - 24))).replace(/\0/g, "").trim();
      const name = /^(SoundHandler|VideoHandler|SubtitleHandler|Core Media Audio|Core Media Video|Core Media Text|Apple (Sound|Video|Text) Media Handler|Sound Media Handler|Sound Handler|Text Handler|Video Handler)$/i.test(rawName) ? "" : rawName;
      const stsdBox = child(moov, stbl, "stsd")!;
      const entry = stsdBox.body + 8;
      const codec = text4(moov, entry + 4);
      let channels = 0;
      let sampleRate = 0;
      if (handler === "soun") {
        channels = moov.getUint16(entry + 8 + 16);
        sampleRate = moov.getUint16(entry + 8 + 24); // the 16.16 rate's whole part; an exact rate lives in the esds for big values
      }
      const need = (t: string) => {
        const b = child(moov, stbl, t);
        return b ? slice(moov, b) : null;
      };
      const stco = need("stco");
      const co64 = need("co64");
      const empty = new DataView(new ArrayBuffer(8));
      tracks.push({
        trackId,
        handler,
        codec,
        language,
        name,
        timescale,
        channels,
        sampleRate,
        tables: {
          stts: need("stts") ?? empty,
          stsz: need("stsz") ?? empty,
          stsc: need("stsc") ?? empty,
          stco: stco ?? co64 ?? empty,
          co64: !stco && !!co64,
          stsd: new Uint8Array(moov.buffer.slice(moov.byteOffset + stsdBox.start, moov.byteOffset + stsdBox.end)),
        },
      });
    } catch {
      // a track that can't be read is left out
    }
  }
  return { tracks, movieTimescale };
}

// ── Samples ──────────────────────────────────────────────────────────────

export interface Samples {
  count: number;
  offset: Float64Array;
  size: Uint32Array;
  /** Decode time of each sample in the track's timescale, and how long it lasts. */
  time: Float64Array;
  duration: Uint32Array;
}

/** Where every sample of a track is in the file and when it plays. */
export function samplesOf(track: Mp4Track): Samples {
  const { stts, stsz, stsc, stco, co64 } = track.tables;
  const fixed = stsz.getUint32(4);
  const count = stsz.byteLength >= 12 ? stsz.getUint32(8) : 0;
  const size = new Uint32Array(count);
  for (let i = 0; i < count; i++) size[i] = fixed || stsz.getUint32(12 + i * 4);

  const duration = new Uint32Array(count);
  const time = new Float64Array(count);
  let i = 0;
  let clock = 0;
  const entries = stts.getUint32(4);
  for (let e = 0; e < entries && i < count; e++) {
    const n = stts.getUint32(8 + e * 8);
    const d = stts.getUint32(12 + e * 8);
    for (let k = 0; k < n && i < count; k++, i++) {
      duration[i] = d;
      time[i] = clock;
      clock += d;
    }
  }

  const chunks = stco.getUint32(4);
  const chunkOffset = (c: number) => (co64 ? stco.getUint32(8 + c * 8) * 2 ** 32 + stco.getUint32(12 + c * 8) : stco.getUint32(8 + c * 4));
  const runs = stsc.getUint32(4);
  const offset = new Float64Array(count);
  let sample = 0;
  for (let r = 0; r < runs; r++) {
    const first = stsc.getUint32(8 + r * 12) - 1;
    const perChunk = stsc.getUint32(12 + r * 12);
    const last = r + 1 < runs ? stsc.getUint32(8 + (r + 1) * 12) - 1 : chunks;
    for (let c = first; c < last && c < chunks; c++) {
      let at = chunkOffset(c);
      for (let k = 0; k < perChunk && sample < count; k++, sample++) {
        offset[sample] = at;
        at += size[sample];
      }
    }
  }
  return { count, offset, size, time, duration };
}

/** The index of the first sample that starts at or after `seconds`. */
export function firstSampleAt(s: Samples, timescale: number, seconds: number): number {
  const target = seconds * timescale;
  let lo = 0;
  let hi = s.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.time[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Audio as fragmented MP4 ──────────────────────────────────────────────

const enc = new TextEncoder();
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), enc.encode(type), body]);
}

const full = (type: string, version: number, flags: number, ...parts: Uint8Array[]) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

/** The first piece a player needs: the track's description, with no samples (they follow as fragments). The track is renumbered 1. */
export function audioInit(track: Mp4Track): Uint8Array {
  const matrix = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10), matrix, new Uint8Array(24), u32(2));
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0), u16(0x0100), u16(0), matrix, u32(0), u32(0));
  const lang = track.language === "und" ? 0x55c4 : track.language.split("").reduce((n, c) => (n << 5) | (c.charCodeAt(0) - 0x60), 0);
  const mdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), u16(lang), u16(0));
  const hdlr = full("hdlr", 0, 0, u32(0), enc.encode("soun"), new Uint8Array(12), enc.encode("Roam\0"));
  const smhd = full("smhd", 0, 0, u16(0), u16(0));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const empty = (t: string, ...extra: Uint8Array[]) => full(t, 0, 0, u32(0), ...extra);
  const stbl = box("stbl", track.tables.stsd, empty("stts"), empty("stsc"), full("stsz", 0, 0, u32(0), u32(0)), empty("stco"));
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", smhd, dinf, stbl)));
  const trex = full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
  const moov = box("moov", mvhd, trak, box("mvex", trex));
  const ftyp = box("ftyp", enc.encode("isom"), u32(512), enc.encode("isom"), enc.encode("iso6"), enc.encode("mp41"));
  return concat([ftyp, moov]);
}

/** The sample index ranges (from inclusive, to exclusive) for each {@link FRAGMENT_SECONDS} window of the track. */
export function fragmentRange(s: Samples, timescale: number, n: number): [number, number] {
  return [firstSampleAt(s, timescale, n * FRAGMENT_SECONDS), firstSampleAt(s, timescale, (n + 1) * FRAGMENT_SECONDS)];
}

const PARALLEL_READS = 6;

/** The bytes of samples [from, to) as separate buffers, reading each run of neighbouring samples with one request. */
export async function readSamples(fetchRange: ByteRangeFetcher, s: Samples, from: number, to: number): Promise<Uint8Array[]> {
  const runs: { first: number; last: number; start: number; end: number }[] = [];
  for (let i = from; i < to; i++) {
    const run = runs[runs.length - 1];
    if (run && s.offset[i] === run.end) {
      run.last = i;
      run.end += s.size[i];
    } else runs.push({ first: i, last: i, start: s.offset[i], end: s.offset[i] + s.size[i] });
  }
  const out: Uint8Array[] = new Array(to - from);
  let next = 0;
  const worker = async () => {
    while (next < runs.length) {
      const run = runs[next++];
      const bytes = new Uint8Array(await fetchRange(run.start, run.end - 1));
      if (bytes.length < run.end - run.start) throw new TracksError("The file ended early.");
      let at = 0;
      for (let i = run.first; i <= run.last; i++) {
        out[i - from] = bytes.subarray(at, at + s.size[i]);
        at += s.size[i];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, runs.length) }, worker));
  return out;
}

/** One playable piece (moof + mdat) holding samples [from, to) of an audio track, stamped with their decode time. */
export function audioFragment(s: Samples, from: number, to: number, data: Uint8Array[], sequence: number): Uint8Array {
  const n = to - from;
  const tfhd = full("tfhd", 0, 0x020000, u32(1)); // default-base-is-moof
  const tfdt = full("tfdt", 1, 0, u32(Math.floor(s.time[from] / 2 ** 32)), u32(s.time[from] % 2 ** 32));
  const rows = new Uint8Array(n * 8);
  const view = new DataView(rows.buffer);
  for (let i = 0; i < n; i++) {
    view.setUint32(i * 8, s.duration[from + i]);
    view.setUint32(i * 8 + 4, s.size[from + i]);
  }
  const trunHead = (offset: number) => full("trun", 0, 0x000301, u32(n), u32(offset), rows);
  const mfhd = full("mfhd", 0, 0, u32(sequence));
  const measure = box("moof", mfhd, box("traf", tfhd, tfdt, trunHead(0))).length;
  const moof = box("moof", mfhd, box("traf", tfhd, tfdt, trunHead(measure + 8)));
  return concat([moof, box("mdat", ...data)]);
}

// ── Subtitles ────────────────────────────────────────────────────────────

/** A subtitle cue: start and end seconds, and the words. */
export type TextCue = [number, number, string];

/** The cues of a `tx3g` (mov_text) track: each sample is a 2-byte length and the words; an empty one clears the screen. */
export async function textCues(fetchRange: ByteRangeFetcher, track: Mp4Track): Promise<TextCue[]> {
  const s = samplesOf(track);
  const data = await readSamples(fetchRange, s, 0, s.count);
  const cues: TextCue[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < s.count; i++) {
    const bytes = data[i];
    if (bytes.length < 2) continue;
    const length = (bytes[0] << 8) | bytes[1];
    if (length === 0) continue;
    const words = decoder.decode(bytes.subarray(2, 2 + length)).replace(/\r/g, "").trim();
    if (!words) continue;
    cues.push([s.time[i] / track.timescale, (s.time[i] + s.duration[i]) / track.timescale, words]);
  }
  return cues;
}

// ── What a viewer is offered ─────────────────────────────────────────────

export interface AudioTrackInfo {
  /** Counting audio tracks only, from 0 in file order; what the audio route takes. */
  index: number;
  language: string;
  label: string;
  codec: string;
  channels: number;
  /** The browser's media type for it (with codec), or null when it has no way to play it (AC-3, DTS...). */
  mime: string | null;
  default: boolean;
}

export interface TextTrackInfo {
  index: number;
  language: string;
  label: string;
}

const LANGUAGES: Record<string, string> = { eng: "English", spa: "Spanish", por: "Portuguese", fra: "French", fre: "French", deu: "German", ger: "German", ita: "Italian", jpn: "Japanese", kor: "Korean", zho: "Chinese", chi: "Chinese", rus: "Russian", ara: "Arabic", hin: "Hindi", nld: "Dutch", dut: "Dutch", swe: "Swedish", pol: "Polish", tur: "Turkish", heb: "Hebrew", und: "Unknown" };
export const languageName = (code: string) => LANGUAGES[code] ?? code.toUpperCase();

const channelWords = (n: number) => (n === 1 ? "Mono" : n === 2 ? "Stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : n > 0 ? `${n} channels` : "");

/** The mime type a browser needs to play this audio through MSE: AAC only (the one codec every browser takes). */
function mimeFor(track: Mp4Track): string | null {
  if (track.codec !== "mp4a") return null;
  return 'audio/mp4; codecs="mp4a.40.2"';
}

export function describeTracks(tracks: Mp4Track[]): { audioTracks: AudioTrackInfo[]; textTracks: TextTrackInfo[] } {
  const audioTracks = tracks
    .filter((t) => t.handler === "soun")
    .map((t, index) => ({
      index,
      language: t.language,
      label: t.name || `${languageName(t.language)} ${channelWords(t.channels)}`.trim(),
      codec: t.codec,
      channels: t.channels,
      mime: mimeFor(t),
      default: index === 0,
    }));
  const textTracks = tracks
    .filter((t) => t.codec === "tx3g")
    .map((t, index) => ({ index, language: t.language, label: t.name || languageName(t.language) }));
  return { audioTracks, textTracks };
}

export const audioTrack = (tracks: Mp4Track[], index: number) => tracks.filter((t) => t.handler === "soun")[index];
export const textTrack = (tracks: Mp4Track[], index: number) => tracks.filter((t) => t.codec === "tx3g")[index];
