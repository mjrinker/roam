/**
 * Subtitle files in, one clean cue list out. Reads SRT, WebVTT and ASS/SSA (styling is dropped: what is kept is the timing and the words),
 * from UTF-8, UTF-16 or Windows-1252 bytes. Nothing here trusts the file: sizes and counts are capped, every scan is linear, and the text
 * that comes out is plain (tags removed), to be drawn with textContent and never as HTML.
 */

/** [start seconds, end seconds, text with "\n" between lines]. */
export type Cue = [number, number, string];

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
export const MAX_CUES = 20_000;
const MAX_CUE_TEXT = 1_000;
const MAX_SECONDS = 48 * 3600;

export type ParseResult = { ok: true; cues: Cue[]; format: "srt" | "vtt" | "ass" } | { ok: false; error: string };

/** Bytes to text: a byte-order mark decides UTF-8 or UTF-16; otherwise valid UTF-8, else Windows-1252 (what old subtitle files usually are). */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

/** Plain text from a cue's lines: markup tags and ASS overrides removed, a few entities decoded, blank lines dropped. */
export function cleanCueText(raw: string): string {
  const withoutBraces = raw.replace(/\{[^{}]{0,200}\}/g, ""); // {\an8}, {\i1}: ASS-style overrides that SRT files carry too
  const withoutTags = withoutBraces.replace(/<\/?[a-zA-Z][^<>]{0,100}>/g, "");
  const decoded = withoutTags.replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, (m) => ENTITIES[m] ?? m);
  return decoded
    .split("\n")
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]{2,}/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n")
    .slice(0, MAX_CUE_TEXT);
}

/** "01:02:03,456", "1:02.5" and "00:01:02.345" to seconds; null when it isn't a time. */
function parseClock(text: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0;
  const seconds = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + frac;
  return seconds <= MAX_SECONDS ? seconds : null;
}

/** An ASS time, "0:01:02.34" (centiseconds). */
function parseAssClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(2, "0").slice(0, 3)) / (m[4].length >= 3 ? 1000 : 100);
  return seconds <= MAX_SECONDS ? seconds : null;
}

/** Which format a file is, from what it starts with and what it contains. */
export function detectFormat(text: string): "srt" | "vtt" | "ass" | null {
  const head = text.slice(0, 2000).replace(/^﻿/, "").trimStart();
  if (/^WEBVTT/.test(head)) return "vtt";
  if (/^\[Script Info\]/i.test(head) || /\n\[Events\]/i.test(text.slice(0, 20_000)) || /^\[Events\]/i.test(head)) return "ass";
  if (text.indexOf("-->") !== -1) return "srt";
  return null;
}

/** The "start --> end" pair on a line, or null (settings after the end time, like "line:90%", are ignored). */
function timingLine(line: string): { start: number; end: number } | null {
  const arrow = line.indexOf("-->");
  if (arrow === -1 || arrow > 40) return null;
  const start = parseClock(line.slice(0, arrow));
  const after = line.slice(arrow + 3).trim();
  const space = after.search(/\s/);
  const end = parseClock(space === -1 ? after : after.slice(0, space));
  return start === null || end === null ? null : { start, end };
}

/** SRT and WebVTT share a shape: blocks separated by blank lines, an optional id, a timing line, then the text. */
function parseBlocks(text: string, isVtt: boolean): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    if (cues.length >= MAX_CUES) break;
    const lines = block.split("\n");
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) continue;
    if (isVtt && /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[i])) continue;
    let timing = timingLine(lines[i]);
    if (!timing && i + 1 < lines.length) {
      i++; // the first line was a cue number or id
      timing = timingLine(lines[i]);
    }
    if (!timing) continue;
    const body = cleanCueText(lines.slice(i + 1).join("\n"));
    if (body === "") continue;
    cues.push([timing.start, timing.end, body]);
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let inEvents = false;
  let startAt = 1;
  let endAt = 2;
  let textAt = 9;
  let columns = 10;
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (cues.length >= MAX_CUES) break;
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) {
      const names = line.slice(7).split(",").map((n) => n.trim().toLowerCase());
      columns = names.length;
      startAt = Math.max(0, names.indexOf("start"));
      endAt = Math.max(0, names.indexOf("end"));
      textAt = names.indexOf("text") === -1 ? columns - 1 : names.indexOf("text");
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue; // Comment: lines and anything else
    // The text is the last column and may itself contain commas: split off only as many fields as there are before it.
    const fields: string[] = [];
    let rest = line.slice(9);
    for (let k = 0; k < textAt; k++) {
      const comma = rest.indexOf(",");
      if (comma === -1) break;
      fields.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1);
    }
    if (fields.length < textAt) continue;
    const start = parseAssClock(fields[startAt] ?? "");
    const end = parseAssClock(fields[endAt] ?? "");
    if (start === null || end === null) continue;
    if (/\{[^}]*\\p[1-9]/.test(rest)) continue; // a drawing, not words
    const words = cleanCueText(rest.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
    if (words !== "") cues.push([start, end, words]);
  }
  return cues;
}

/** Sorted, with impossible times mended or dropped. */
function tidy(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const [start, end, text] of cues) {
    if (!(start >= 0) || start > MAX_SECONDS) continue;
    out.push([Math.round(start * 1000) / 1000, Math.round((end > start ? end : start + 2) * 1000) / 1000, text]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Subtitle text to cues. Fails with a message a person can act on (wrong kind of file, nothing readable in it). */
export function parseSubtitles(text: string): ParseResult {
  const format = detectFormat(text);
  if (!format) return { ok: false, error: "That doesn't look like a subtitle file (SRT, WebVTT or ASS)." };
  const cues = tidy(format === "ass" ? parseAss(text) : parseBlocks(text, format === "vtt"));
  if (cues.length === 0) return { ok: false, error: "No subtitles could be read from that file." };
  return { ok: true, cues, format };
}

/** Bytes of a subtitle file to cues, with the size limit applied first. */
export function parseSubtitleBytes(bytes: Uint8Array): ParseResult {
  if (bytes.length === 0) return { ok: false, error: "That file is empty." };
  if (bytes.length > MAX_SUBTITLE_BYTES) return { ok: false, error: "That file is too large for a subtitle file (2 MB at most)." };
  return parseSubtitles(decodeSubtitleBytes(bytes));
}

/** The cues showing at `time` seconds (a few can overlap). `offset` shifts the whole track (positive makes it come later). */
export function activeCues(cues: readonly Cue[], time: number, offset = 0): Cue[] {
  const t = time - offset;
  const out: Cue[] = [];
  // Cues are sorted by start, so everything that can be showing starts at or before `t`; binary search to the last of those.
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 16; i--) if (cues[i][1] > t) out.unshift(cues[i]);
  return out;
}
