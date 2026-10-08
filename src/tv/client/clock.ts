/** Time and position helpers for the TV player. Written for old browsers: no padStart (Chromium 57), no Intl. */

const two = (n: number) => (n < 10 ? "0" + n : String(n));

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h > 0 ? h + ":" + two(m) : String(m)) + ":" + two(s % 60);
}

export interface Segment {
  index: number;
  url: string;
  durationSeconds: number;
  startSeconds: number;
  inFileOffsetSeconds?: number;
  inFileEndSeconds?: number;
}

/** Which part of a movie a moment on the whole timeline falls in, and where inside that part. The last part takes anything past the end. */
export function locate(segments: Segment[], seconds: number): { segment: Segment; localTime: number } {
  const t = Math.max(0, seconds);
  let found = segments[segments.length - 1];
  for (let i = 0; i < segments.length; i++) {
    if (t < segments[i].startSeconds + segments[i].durationSeconds) {
      found = segments[i];
      break;
    }
  }
  const local = Math.min(Math.max(0, t - found.startSeconds), found.durationSeconds);
  return { segment: found, localTime: local + (found.inFileOffsetSeconds ?? 0) };
}

/** Whole-timeline seconds for a position inside a part's file. */
export function timelineAt(segment: Segment, fileTime: number): number {
  return segment.startSeconds + Math.max(0, fileTime - (segment.inFileOffsetSeconds ?? 0));
}

/** Within the last stretch of a title, it counts as watched. */
export function isFinished(position: number, duration: number): boolean {
  return duration > 0 && (position >= duration - 30 || position / duration >= 0.97);
}
