/**
 * Finding the stretch two fingerprints share, and agreeing on it across a season. Pure, so it is tested without audio.
 */
import { FRAME_SECONDS, popcount } from "@/lib/intro/fingerprint";

/** The number of set bits in each 16-bit value. */
const TABLE = Uint8Array.from({ length: 65536 }, (_, i) => popcount(i));

/** How far apart (in time) the shared part can start in the two episodes. */
export const MAX_OFFSET_SECONDS = 240;
/** The shortest and longest stretch counted as an intro or credits. */
export const MIN_SEGMENT_SECONDS = 15;
export const MAX_SEGMENT_SECONDS = 200;
/**
 * A frame "matches" when this share of its bits agree (unrelated sound sits near half; the same music, even with a voice laid over it, is far
 * higher). The shared stretch is a chain of matching frames with no gap longer than MAX_GAP_FRAMES (a note change, a line of dialogue over the
 * music), of which at least MIN_DENSITY are matches.
 */
export const FRAME_MATCH = 0.72;
export const MAX_GAP_FRAMES = 8;
export const MIN_DENSITY = 0.5;

export interface Shared {
  /** Where the shared stretch starts in each episode's own window, and how long it is, in seconds. */
  aStart: number;
  bStart: number;
  seconds: number;
  /** Mean bit agreement over it (0 to 1). */
  agreement: number;
}

/** The longest stretch the two fingerprints share, at the best time offset between them; null when there is none long enough. */
export function sharedSegment(a: Uint32Array, b: Uint32Array, opts: { maxOffsetSeconds?: number; minSeconds?: number; maxSeconds?: number } = {}): Shared | null {
  const maxLag = Math.round((opts.maxOffsetSeconds ?? MAX_OFFSET_SECONDS) / FRAME_SECONDS);
  const minFrames = Math.ceil((opts.minSeconds ?? MIN_SEGMENT_SECONDS) / FRAME_SECONDS);
  const maxFrames = Math.floor((opts.maxSeconds ?? MAX_SEGMENT_SECONDS) / FRAME_SECONDS);
  const found: { best: (Shared & { frames: number }) | null } = { best: null };

  const matchBits = Math.ceil(FRAME_MATCH * 32);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const from = Math.max(0, -lag);
    const to = Math.min(a.length, b.length - lag);
    if (to - from < minFrames) continue;
    let chainStart = -1;
    let lastGood = -1;
    let goods = 0;
    let sum = 0;
    for (let i = from; i <= to; i++) {
      // (One step past the end closes a chain still open.)
      let same = -1;
      if (i < to) {
        const x = (a[i] ^ b[i + lag]) >>> 0;
        const same32 = 32 - (TABLE[x & 0xffff] + TABLE[x >>> 16]);
        if (same32 >= matchBits) same = same32;
      }
      const closing = i === to || (same >= 0 && chainStart >= 0 && i - lastGood > MAX_GAP_FRAMES);
      if (closing && chainStart >= 0) {
        const frames = lastGood - chainStart + 1;
        if (frames >= minFrames && goods / frames >= MIN_DENSITY) {
          const used = Math.min(frames, maxFrames);
          const agreement = sum / 32 / frames;
          const best = found.best;
          if (!best || used > best.frames + 4 || (Math.abs(used - best.frames) <= 4 && agreement > best.agreement)) {
            found.best = { aStart: chainStart * FRAME_SECONDS, bStart: (chainStart + lag) * FRAME_SECONDS, seconds: used * FRAME_SECONDS, agreement, frames: used };
          }
        }
        chainStart = -1;
      }
      if (same < 0) continue;
      if (chainStart < 0) [chainStart, goods, sum] = [i, 0, 0];
      lastGood = i;
      goods++;
      sum += same;
    }
  }
  const best = found.best;
  return best ? { aStart: best.aStart, bStart: best.bStart, seconds: best.seconds, agreement: best.agreement } : null;
}

/** The best stretch `a` shares with `b` at any of b's phases (a is the one whose time the answer is in). */
export function bestShared(a: Uint32Array, bPhases: readonly Uint32Array[], opts: Parameters<typeof sharedSegment>[2] = {}): Shared | null {
  let best: Shared | null = null;
  for (const b of bPhases) {
    const s = sharedSegment(a, b, opts);
    if (s && (!best || s.seconds > best.seconds + 1 || (Math.abs(s.seconds - best.seconds) <= 1 && s.agreement > best.agreement))) best = s;
  }
  return best;
}

export interface Candidate {
  start: number;
  end: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * What one episode's pairings with the others agree on: candidates (one per pairing that found something) are grouped by where they start
 * and end; the biggest group wins if at least `minAgree` of them (and a quarter of `tried`) back it. The answer is the group's median.
 */
export function agree(candidates: readonly Candidate[], tried: number, opts: { startSlack?: number; endSlack?: number; minAgree?: number } = {}): (Candidate & { support: number }) | null {
  const startSlack = opts.startSlack ?? 4;
  const endSlack = opts.endSlack ?? 5;
  const minAgree = opts.minAgree ?? 2;
  let best: Candidate[] = [];
  for (const c of candidates) {
    const group = candidates.filter((o) => Math.abs(o.start - c.start) <= startSlack && Math.abs(o.end - c.end) <= endSlack);
    if (group.length > best.length) best = group;
  }
  if (best.length < minAgree || best.length < Math.ceil(tried / 4)) return null;
  return { start: Math.round(median(best.map((c) => c.start)) * 10) / 10, end: Math.round(median(best.map((c) => c.end)) * 10) / 10, support: best.length };
}
