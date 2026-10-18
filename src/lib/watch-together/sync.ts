/**
 * Watching together: how a player decides, each time it looks in, whether to follow the shared state or to change it. Pure, so the hard part
 * (telling the viewer's own press of pause from the player catching up to someone else's) is tested without a browser.
 */
export interface SharedState {
  playing: boolean;
  /** Where the shared video is at `at` (server ms), seconds. */
  position: number;
  rate: number;
  seq: number;
  /** The server's clock when `position` was true, and now, in ms. */
  at: number;
  now: number;
}

export interface LocalState {
  playing: boolean;
  /** Seconds into the whole video. */
  time: number;
}

/** Where the shared video is now. */
export function sharedPositionNow(s: SharedState): number {
  return s.playing ? s.position + ((s.now - s.at) / 1000) * s.rate : s.position;
}

export interface Looked {
  /** The player as it was at the last look, and how long ago, ms. */
  previous: LocalState | null;
  elapsedMs: number;
  local: LocalState;
  shared: SharedState;
  /** The highest `seq` this player has already followed (or caused). */
  seenSeq: number;
}

export type Decision =
  | { kind: "none" }
  /** The viewer did something (pressed play or pause, or jumped): tell the others. */
  | { kind: "push"; playing: boolean; position: number }
  /** Someone else did: do the same here. */
  | { kind: "follow"; playing: boolean; position: number; seq: number };

/** How far apart the shared position and this player may drift before it is pulled back, seconds. */
export const DRIFT_SECONDS = 2.5;
/** A jump of at least this much between looks, beyond what playing explains, is the viewer seeking. */
export const SEEK_SECONDS = 2;

export function decide(l: Looked): Decision {
  const { previous, local, shared } = l;
  if (previous) {
    const moved = local.time - previous.time;
    const expected = previous.playing ? (l.elapsedMs / 1000) * shared.rate : 0;
    const sought = Math.abs(moved - expected) > SEEK_SECONDS + (l.elapsedMs / 1000) * 0.5;
    // A change of play state or position this player did not make by following: the viewer's own.
    if (local.playing !== previous.playing || sought) {
      // Unless it is the player doing what the shared state already says (it was just brought in line).
      const target = sharedPositionNow(shared);
      const agrees = local.playing === shared.playing && Math.abs(local.time - target) <= DRIFT_SECONDS;
      if (!agrees) return { kind: "push", playing: local.playing, position: local.time };
    }
  }
  if (shared.seq > l.seenSeq) {
    const target = sharedPositionNow(shared);
    if (local.playing !== shared.playing || Math.abs(local.time - target) > DRIFT_SECONDS) return { kind: "follow", playing: shared.playing, position: target, seq: shared.seq };
    return { kind: "follow", playing: local.playing, position: local.time, seq: shared.seq }; // already in line: just note the change
  }
  // No new change, but drifting apart while both play: pull back (a slow connection, a buffering pause).
  if (shared.playing && local.playing && Math.abs(local.time - sharedPositionNow(shared)) > DRIFT_SECONDS * 2) return { kind: "follow", playing: true, position: sharedPositionNow(shared), seq: shared.seq };
  return { kind: "none" };
}
