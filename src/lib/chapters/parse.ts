/**
 * Chapter files that sit beside a movie or episode, named like the video with ".chapters" and an extension
 * ("The Matrix (1999).chapters.xml"). Three formats, all plain text:
 *
 * - `.chapters.xml`: Matroska chapter XML (what mkvtoolnix and MKVToolNix GUI export; the one format with a standard).
 * - `.chapters.txt`: either the OGM "simple" format (CHAPTER01=00:00:00.000 / CHAPTER01NAME=Opening) or one chapter per
 *   line, a time then a title ("00:00 Opening", "1:02:30 The chase"), the way a YouTube description lists them.
 * - `.chapters.vtt`: WebVTT, with each cue's start as the chapter's time and its text as the title.
 *
 * These files are untrusted text: input size and chapter count are capped, and a file that doesn't parse gives nothing.
 */

export interface RawChapter {
  title: string;
  startSeconds: number;
}

const MAX_CHARS = 256 * 1024;
export const MAX_CHAPTERS = 500;
const MAX_TITLE = 120;

const CHAPTER_FILE = /^(.*)\.chapters\.(xml|txt|vtt)$/i;

/** True for a file name that is a chapter file. */
export const isChapterFile = (fileName: string) => CHAPTER_FILE.test(fileName);

/** "Movie (2020).chapters.xml" -> "Movie (2020)": the name of the video it belongs to, without its extension; null if not a chapter file. */
export function chapterFileVideoBase(fileName: string): string | null {
  return CHAPTER_FILE.exec(fileName)?.[1] ?? null;
}

/** Clock text to seconds: "1:02:30.5", "02:30", "90", "00:00:05,250". Null when it isn't a time. */
export function parseClock(text: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,9}))?\s*$/.exec(text) ?? /^\s*()()(\d{1,6})(?:[.,](\d{1,9}))?\s*$/.exec(text);
  if (!m) return null;
  const [, h, min, s, frac] = m;
  // Two numbers read as minutes:seconds ("02:30"); a leading single number alone is seconds.
  const seconds = Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const cleanTitle = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

/** Matroska chapter XML: each ChapterAtom's start time and its first ChapterString; hidden chapters are left out. */
export function parseMatroskaXml(text: string): RawChapter[] {
  const out: RawChapter[] = [];
  // The part from one atom's opening tag to the next opening tag holds that atom's own time and name (nested atoms start new parts).
  for (const part of text.slice(0, MAX_CHARS).split(/<ChapterAtom\b/).slice(1)) {
    if (out.length >= MAX_CHAPTERS) break;
    if (/<ChapterFlagHidden>\s*1\s*</.test(part.split(/<ChapterAtom\b/)[0])) continue;
    const start = /<ChapterTimeStart>([^<]*)</.exec(part)?.[1];
    const seconds = start ? parseClock(start.trim()) : null;
    if (seconds === null) continue;
    const name = /<ChapterString>([^<]*)</.exec(part)?.[1] ?? "";
    out.push({ title: cleanTitle(decodeEntities(name)), startSeconds: seconds });
  }
  return out;
}

/** OGM simple chapters (CHAPTER01=time, CHAPTER01NAME=name), or lines of "time title". */
export function parseChapterText(text: string): RawChapter[] {
  const lines = text.slice(0, MAX_CHARS).replace(/^﻿/, "").split(/\r?\n/);
  const ogmTimes = new Map<string, number>();
  const ogmNames = new Map<string, string>();
  const listed: RawChapter[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const ogm = /^CHAPTER(\d{1,4})(NAME)?\s*=\s*(.*)$/i.exec(line);
    if (ogm) {
      if (ogm[2]) ogmNames.set(ogm[1], cleanTitle(ogm[3]));
      else {
        const seconds = parseClock(ogm[3]);
        if (seconds !== null) ogmTimes.set(ogm[1], seconds);
      }
      continue;
    }
    // "00:00 Opening", "[1:02:30] The chase", "0:00 - Intro"
    const item = /^[[(]?(\d{1,3}(?::\d{1,2}){1,2}(?:[.,]\d{1,3})?)[\])]?\s*[-–—:.]?\s*(.*)$/.exec(line);
    if (item) {
      const seconds = parseClock(item[1]);
      if (seconds !== null) listed.push({ title: cleanTitle(item[2]), startSeconds: seconds });
    }
  }
  if (ogmTimes.size > 0) {
    return [...ogmTimes.entries()].slice(0, MAX_CHAPTERS).map(([key, startSeconds]) => ({ title: ogmNames.get(key) ?? "", startSeconds }));
  }
  return listed.slice(0, MAX_CHAPTERS);
}

/** WebVTT: each cue's start is a chapter, and the cue's text (an identifier line before the timing is ignored) is its title. */
export function parseWebVtt(text: string): RawChapter[] {
  const out: RawChapter[] = [];
  const blocks = text.slice(0, MAX_CHARS).replace(/^﻿/, "").split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    if (out.length >= MAX_CHAPTERS) break;
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const seconds = parseClock(lines[at].split("-->")[0]);
    if (seconds === null) continue;
    out.push({ title: cleanTitle(lines.slice(at + 1).join(" ").replace(/<[^>]*>/g, "")), startSeconds: seconds });
  }
  return out;
}

/** The chapters in a chapter file, picked by its extension. An unreadable file gives an empty list. */
export function parseChapterFile(fileName: string, text: string): RawChapter[] {
  const ext = CHAPTER_FILE.exec(fileName)?.[2]?.toLowerCase();
  try {
    if (ext === "xml") return parseMatroskaXml(text);
    if (ext === "vtt") return parseWebVtt(text);
    if (ext === "txt") return parseChapterText(text);
  } catch {
    // fall through: a file that can't be parsed has no chapters
  }
  return [];
}
