/** Chapters of a movie or episode: cleaning what files say, putting each part's chapters on the one playback clock, and the scrubber's snapping. */
import type { RawChapter } from "@/lib/chapters/parse";

export interface Chapter {
  title: string;
  startSeconds: number;
}

/** Two chapters closer than this are one (a file listing the same moment twice). */
const SAME_MOMENT_SECONDS = 0.5;
/** A chapter this close to the very end is credits-roll noise, not somewhere to jump to. */
const END_MARGIN_SECONDS = 2;

/** Titles that are just the numbered placeholder muxers write ("Chapter 3", "chapter 03"). */
export const isGenericChapterTitle = (title: string) => /^chapter\s*\d+$/i.test(title.trim());

/**
 * Sorted, deduplicated chapters within the video, with blank titles named. `durationSeconds` drops chapters past the end; leave it out
 * when the length isn't known yet.
 */
export function cleanChapters(raw: RawChapter[] | null | undefined, durationSeconds?: number | null): Chapter[] {
  const sorted = (raw ?? [])
    .filter((c) => Number.isFinite(c.startSeconds) && c.startSeconds >= 0 && (durationSeconds == null || c.startSeconds < durationSeconds - END_MARGIN_SECONDS))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const out: Chapter[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.startSeconds - last.startSeconds < SAME_MOMENT_SECONDS) continue;
    out.push({ title: c.title.trim(), startSeconds: c.startSeconds });
  }
  return out.map((c, i) => ({ title: c.title || `Chapter ${i + 1}`, startSeconds: c.startSeconds }));
}

export interface ChapterSegment {
  /** Where this segment starts on the playback clock. */
  startSeconds: number;
  durationSeconds: number;
  /** For a trimmed segment (one episode's slice of a combined file): the window of the physical file it plays. */
  inFileOffsetSeconds?: number;
  inFileEndSeconds?: number;
  /** This file's own chapters, timed from the start of the physical file. */
  chapters: RawChapter[] | null;
}

/**
 * The chapters of a whole playback: every segment's own chapters moved onto the one clock. A part's boundary is NOT a chapter; it shows
 * only if the part's own chapters say so (a first chapter at the part's start). A trimmed segment keeps only the chapters inside its
 * window. When every chapter is a placeholder title ("Chapter 1"), they are numbered afresh across the parts. Fewer than two chapters
 * is not worth showing: nothing is returned.
 */
export function playbackChapters(segments: ChapterSegment[], durationSeconds: number): Chapter[] {
  const all: Chapter[] = [];
  for (const seg of segments) {
    const offset = seg.inFileOffsetSeconds ?? 0;
    const end = seg.inFileEndSeconds ?? Number.POSITIVE_INFINITY;
    for (const c of seg.chapters ?? []) {
      if (c.startSeconds < offset - 0.001 || c.startSeconds >= end) continue;
      all.push({ title: c.title, startSeconds: seg.startSeconds + (c.startSeconds - offset) });
    }
  }
  const cleaned = cleanChapters(all, durationSeconds);
  if (cleaned.length < 2) return [];
  return cleaned.every((c) => isGenericChapterTitle(c.title)) ? cleaned.map((c, i) => ({ ...c, title: `Chapter ${i + 1}` })) : cleaned;
}

/** The chapter playing at `time` (index), or -1 before the first one. */
export function chapterIndexAtTime(chapters: Chapter[], time: number): number {
  let found = -1;
  for (let i = 0; i < chapters.length && chapters[i].startSeconds <= time + 0.001; i++) found = i;
  return found;
}

/**
 * Where a drag or click on the scrubber lands: on a chapter mark when it is within `thresholdPx` of one (measured on screen, so the
 * pull feels the same on a long film and a short one), otherwise where it is. Returns the time and the chapter it snapped to, if any.
 */
export function snapToChapter(
  time: number,
  chapters: Chapter[],
  durationSeconds: number,
  barWidthPx: number,
  thresholdPx = 10
): { time: number; chapter: Chapter | null } {
  if (chapters.length === 0 || durationSeconds <= 0 || barWidthPx <= 0) return { time, chapter: null };
  const pxPerSecond = barWidthPx / durationSeconds;
  let best: Chapter | null = null;
  let bestPx = thresholdPx;
  for (const c of chapters) {
    const px = Math.abs(c.startSeconds - time) * pxPerSecond;
    if (px <= bestPx) {
      best = c;
      bestPx = px;
    }
  }
  return best ? { time: best.startSeconds, chapter: best } : { time, chapter: null };
}
