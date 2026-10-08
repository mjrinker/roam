/**
 * Moving the highlight with the arrow keys: from the element in focus to the nearest one in the direction pressed. Pure
 * geometry, so it is tested without a browser; tv.ts turns real elements into these rectangles.
 */
import type { Direction } from "./keys";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const centerX = (b: Box) => (b.left + b.right) / 2;
const centerY = (b: Box) => (b.top + b.bottom) / 2;

/** How far apart two intervals are (0 when they overlap). */
const intervalGap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * The index of the box to move to from `from`, or -1 if there is nothing that way. A candidate must be centred beyond the current
 * box in the direction pressed; of those, the one with the least gap wins, with sideways drift penalised so a press moves along its
 * row or column when it can and only then jumps to the next one.
 */
export function pickNext(from: Box, candidates: Box[], dir: Direction): number {
  const horizontal = dir === "left" || dir === "right";
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const dx = centerX(c) - centerX(from);
    const dy = centerY(c) - centerY(from);
    const ahead = dir === "right" ? dx > 1 : dir === "left" ? dx < -1 : dir === "down" ? dy > 1 : dy < -1;
    if (!ahead) continue;
    const gap = horizontal ? (dir === "right" ? c.left - from.right : from.left - c.right) : dir === "down" ? c.top - from.bottom : from.top - c.bottom;
    const side = horizontal ? intervalGap(from.top, from.bottom, c.top, c.bottom) : intervalGap(from.left, from.right, c.left, c.right);
    const drift = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = Math.max(gap, 0) + side * 3 + drift * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
