/**
 * Pure helpers for a playback timeline made of ordered file segments (a
 * "global" clock spanning every part) with optional chapters on top. Shared
 * by the audiobook player; no DOM or DB access.
 */

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
