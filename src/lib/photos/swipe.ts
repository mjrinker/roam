/**
 * Reading a finger swipe on the photo viewer. Pure so the rules are testable: a swipe counts only if it
 * is mostly sideways, long enough (or fast enough), and made with one finger. Swiping left shows the
 * next photo, right the previous one (like turning pages).
 */
export const SWIPE_MIN_DISTANCE = 60;
export const SWIPE_FLICK_DISTANCE = 30;
export const SWIPE_FLICK_MS = 250;

export type SwipeDecision = "next" | "prev" | null;

export function decideSwipe(d: { dx: number; dy: number; ms: number; fingers: number }): SwipeDecision {
  if (d.fingers !== 1) return null; // a pinch is a zoom, not a swipe
  const ax = Math.abs(d.dx);
  if (ax < Math.abs(d.dy) * 1.5) return null; // mostly vertical: scrolling or a drag, not a swipe
  const far = ax >= SWIPE_MIN_DISTANCE;
  const flick = ax >= SWIPE_FLICK_DISTANCE && d.ms <= SWIPE_FLICK_MS;
  if (!far && !flick) return null;
  return d.dx < 0 ? "next" : "prev";
}
