/**
 * Pure helpers for a playback timeline made of ordered file segments (a
 * "global" clock spanning every part) with optional chapters on top. Shared
 * by the audiobook player; no DOM or DB access.
 */

import type { PlaySegment } from "@/lib/player/types";

export interface TimelineSegment {
  startSeconds: number;
  durationSeconds: number;
}

export interface TimelineChapter {
  title: string;
  startSeconds: number;
}

/** Which segment a global time falls in, and the offset within it. Times outside the timeline clamp to its ends. */
export function findSegmentAt<T extends TimelineSegment>(
  segments: T[],
  totalSeconds: number,
  time: number
): { segment: T; index: number; localTime: number } {
  const clamped = Math.max(0, Math.min(time, Math.max(totalSeconds - 0.05, 0)));
  let index = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (clamped < segments[i].startSeconds + segments[i].durationSeconds) {
      index = i;
      break;
    }
  }
  const segment = segments[index];
  return { segment, index, localTime: Math.max(0, clamped - segment.startSeconds) };
}

/** Index of the chapter playing at `time`, or -1 if there are no chapters or it precedes the first. */
export function chapterIndexAt(chapters: TimelineChapter[], time: number): number {
  let lo = 0;
  let hi = chapters.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].startSeconds <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Where chapter `index` ends: the next chapter's start, or the end of the book. */
export function chapterEnd(chapters: TimelineChapter[], index: number, totalSeconds: number): number {
  return index + 1 < chapters.length ? chapters[index + 1].startSeconds : totalSeconds;
}

/** 75 -> "1:15"; 3725 -> "1:02:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * A book counts as finished once this little is left. Absolute time, not a
 * percentage: 2% of a 20-hour book is 24 minutes of story, while credits and
 * outros are a minute or two whatever the length.
 */
export const AUDIOBOOK_FINISHED_REMAINING_SECONDS = 60;

export function isEffectivelyFinished(
  positionSeconds: number,
  durationSeconds: number,
  remainingThreshold = AUDIOBOOK_FINISHED_REMAINING_SECONDS
): boolean {
  return durationSeconds > 0 && durationSeconds - positionSeconds <= remainingThreshold;
}

/** A book only shows up under "continue listening" once there's real progress. */
export const CONTINUE_LISTENING_MIN_SECONDS = 10;

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 3;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, Math.round(rate * 100) / 100));
}

// ── Trimmed segments (multi-episode split playback) ─────────────────────
// A "trimmed" segment plays only a WINDOW of its underlying physical file
// — an episode's estimated slice of a combined multi-episode file (see
// lib/scan/episode-split.ts). The video element itself has no idea: it
// always sees the whole physical file and reports physical (element)
// time. These helpers translate between that physical time and the
// segment's own LOCAL time (0 at the window's start), and detect when
// physical playback has reached the window's virtual end.

export interface TrimmableSegment {
  durationSeconds: number;
  inFileOffsetSeconds?: number;
  inFileEndSeconds?: number;
}

/** ~ one timeupdate tick — how close to the virtual end counts as "there". */
export const VIRTUAL_END_EPSILON_SECONDS = 0.25;
/** How far outside a trim window a native seek (iOS fullscreen, PiP, AirPlay) can land before it's clamped back. */
export const NATIVE_SEEK_TOLERANCE_SECONDS = 0.1;

/**
 * Whether `segment` is trimmed at all. This is the presence of
 * inFileEndSeconds itself, by design — an ordinary segment never has it,
 * not even as `undefined` written explicitly, so this can't be fooled by
 * an object literal that merely mentions the key.
 */
export function hasVirtualEnd(segment: TrimmableSegment): boolean {
  return segment.inFileEndSeconds !== undefined;
}

/** The physical (element) time a given LOCAL (segment-relative) time corresponds to. */
export function toElementTime(segment: TrimmableSegment, localTime: number): number {
  return localTime + (segment.inFileOffsetSeconds ?? 0);
}

/**
 * The LOCAL (segment-relative) time a given physical (element) time
 * corresponds to. Clamped to [0, durationSeconds] ONLY when the segment
 * has a virtual end — for an ordinary segment this is a true identity
 * function (durationSeconds there is rounded to a whole second, so
 * clamping unconditionally would silently change today's behavior right
 * at the end of playback).
 */
export function toLocalTime(segment: TrimmableSegment, elementTime: number): number {
  const local = elementTime - (segment.inFileOffsetSeconds ?? 0);
  if (!hasVirtualEnd(segment)) return local;
  return Math.max(0, Math.min(local, segment.durationSeconds));
}

/** True once physical playback has reached (within `epsilon`) this segment's virtual end. Always false for an untrimmed segment. */
export function crossedVirtualEnd(
  segment: TrimmableSegment,
  elementTime: number,
  epsilon = VIRTUAL_END_EPSILON_SECONDS
): boolean {
  return hasVirtualEnd(segment) && elementTime >= segment.inFileEndSeconds! - epsilon;
}

/** How much of `segment` is left to play, in LOCAL time, from the current physical position. */
export function remainingInSegment(
  segment: TrimmableSegment,
  elementTime: number,
  elementDuration: number
): number {
  return hasVirtualEnd(segment) ? segment.durationSeconds - toLocalTime(segment, elementTime) : elementDuration - elementTime;
}

/**
 * If a NATIVE seek (one the app didn't drive — iOS fullscreen, PiP,
 * AirPlay all work on the physical timeline) has landed outside this
 * segment's window, the nearest boundary to clamp back to. Null if the
 * segment is untrimmed, or the element is already inside the window
 * (within `tolerance`, so ordinary keyframe-snapping jitter can't cause
 * seek ping-pong).
 */
export function windowClampTarget(
  segment: TrimmableSegment,
  elementTime: number,
  tolerance = NATIVE_SEEK_TOLERANCE_SECONDS
): number | null {
  if (!hasVirtualEnd(segment)) return null;
  const start = segment.inFileOffsetSeconds ?? 0;
  const end = segment.inFileEndSeconds!;
  if (elementTime < start - tolerance) return start;
  if (elementTime > end + tolerance) return end;
  return null;
}

export interface SegmentSourceRow {
  durationSeconds: number | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
}

/**
 * Builds one PlaySegment from a media_files row. Lives here (not
 * manifest.ts) because manifest.ts imports `db`, which throws on import in
 * tests without POSTGRES_URL — this needs to be reachable from a plain
 * unit test.
 *
 * When the row has a trim window (an episode's estimated slice of a
 * multi-episode file), inFileOffsetSeconds/inFileEndSeconds describe it
 * and durationSeconds/startSeconds describe the WINDOW, not the whole
 * physical file. For an ordinary row, the trim keys are omitted entirely.
 */
export function buildPlaySegment(
  row: SegmentSourceRow,
  index: number,
  url: string,
  startSeconds: number
): PlaySegment {
  if (row.trimDurationSeconds != null) {
    const offset = row.trimStartSeconds ?? 0;
    return {
      index,
      url,
      durationSeconds: row.trimDurationSeconds,
      startSeconds,
      inFileOffsetSeconds: offset,
      inFileEndSeconds: offset + row.trimDurationSeconds,
    };
  }
  return { index, url, durationSeconds: row.durationSeconds!, startSeconds };
}
