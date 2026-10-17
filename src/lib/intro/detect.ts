/**
 * Finding the opening titles (or closing credits) of the episodes of a season from their sound: each episode is compared with several others, and
 * the stretch they keep sharing at about the same place is the answer. Pure, given the fingerprints.
 */
import { agree, bestShared, type Candidate } from "@/lib/intro/match";

export interface EpisodeAudio {
  id: string;
  /** The fingerprints of the stretch of the episode that was listened to, at each phase (see fingerprintPhases). */
  fps: Uint32Array[];
  /** Where in the episode that stretch begins, in seconds. */
  windowStart: number;
}

export interface Detected {
  /** In the episode's own time. */
  startSeconds: number;
  endSeconds: number;
  /** How many of the comparisons agreed on it. */
  support: number;
  /** How many comparisons were made. */
  tried: number;
}

/** At least this many episodes are needed to tell what they share from chance. */
export const MIN_EPISODES = 3;
/** Each episode is compared with at most this many of the others. */
export const REFERENCES = 6;

/** The others to compare episode `index` with: spread evenly through the season, never itself. */
export function referencesFor(count: number, index: number, wanted = REFERENCES): number[] {
  const others = Array.from({ length: count }, (_, i) => i).filter((i) => i !== index);
  if (others.length <= wanted) return others;
  return Array.from({ length: wanted }, (_, k) => others[Math.floor((k * others.length) / wanted)]);
}

/** For each episode, the stretch it shares with the others (null when nothing is agreed on). */
export function detectShared(episodes: readonly EpisodeAudio[], opts: { references?: number; maxOffsetSeconds?: number } = {}): Map<string, Detected | null> {
  const out = new Map<string, Detected | null>();
  if (episodes.length < MIN_EPISODES) {
    for (const e of episodes) out.set(e.id, null);
    return out;
  }
  episodes.forEach((e, index) => {
    const refs = referencesFor(episodes.length, index, opts.references);
    const found: Candidate[] = [];
    for (const r of refs) {
      const s = bestShared(e.fps[0], episodes[r].fps, { maxOffsetSeconds: opts.maxOffsetSeconds });
      if (s) found.push({ start: s.aStart, end: s.aStart + s.seconds });
    }
    const winner = agree(found, refs.length);
    out.set(e.id, winner ? { startSeconds: winner.start + e.windowStart, endSeconds: winner.end + e.windowStart, support: winner.support, tried: refs.length } : null);
  });
  return out;
}
