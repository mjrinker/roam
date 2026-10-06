/**
 * The maths behind the photo viewer's touch gestures, kept pure so it can be tested: pinch scale, how far
 * a zoomed picture may be dragged, which way a one-finger drag is going, when a drag closes the viewer,
 * and what counts as a double tap.
 */
export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2.5;
/** Past this zoom the full-size original replaces the 2048px preview (if it is a format browsers show). */
export const ORIGINAL_ZOOM_THRESHOLD = 2;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function pinchScale(startDistance: number, distance: number, startScale: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return startScale;
  return clamp(startScale * (distance / startDistance), MIN_SCALE * 0.8, MAX_SCALE); // a little give below 1, snapped back on release
}

/** After a pinch ends: anything near or below 1 snaps to exactly 1. */
export const settleScale = (scale: number) => (scale < 1.05 ? 1 : clamp(scale, MIN_SCALE, MAX_SCALE));

/** How far a picture of `size` shown at `scale` may be moved from centre before its edge leaves the frame. */
export function maxPan(scale: number, frame: { w: number; h: number }) {
  return { x: Math.max(0, (frame.w * scale - frame.w) / 2), y: Math.max(0, (frame.h * scale - frame.h) / 2) };
}

export function clampPan(pan: { x: number; y: number }, scale: number, frame: { w: number; h: number }) {
  const m = maxPan(scale, frame);
  return { x: clamp(pan.x, -m.x, m.x), y: clamp(pan.y, -m.y, m.y) };
}

export type DragAxis = "x" | "y" | null;
const AXIS_LOCK_PX = 10;

/** Which way a one-finger drag is going, decided once it has moved a few pixels and then kept. */
export function dragAxis(dx: number, dy: number): DragAxis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
}

export const CLOSE_DISTANCE = 120;
const CLOSE_FLICK_DISTANCE = 50;
const CLOSE_FLICK_MS = 250;

/** A downward drag closes the viewer when it is far enough, or short but quick. Upward drags never do. */
export function shouldClose(dy: number, ms: number): boolean {
  if (dy <= 0) return false;
  return dy >= CLOSE_DISTANCE || (dy >= CLOSE_FLICK_DISTANCE && ms <= CLOSE_FLICK_MS);
}

export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;
export const TAP_MAX_MOVE_PX = 10;
export const TAP_MAX_MS = 350;

export interface Tap {
  x: number;
  y: number;
  t: number;
}

/** A pointer that barely moved and came up quickly is a tap. */
export function isTap(down: Tap, up: Tap): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= TAP_MAX_MOVE_PX && up.t - down.t <= TAP_MAX_MS;
}

export function isDoubleTap(previous: Tap | null, current: Tap): boolean {
  return !!previous && current.t - previous.t <= DOUBLE_TAP_MS && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_PX;
}

/**
 * Zooming in on a point: keeps the point under the finger fixed. `focus` is the point relative to the
 * frame's centre; the result is the pan that goes with the new scale (before clamping).
 */
export function panForZoom(pan: { x: number; y: number }, scale: number, nextScale: number, focus: { x: number; y: number }) {
  const ratio = nextScale / scale;
  return { x: focus.x - (focus.x - pan.x) * ratio, y: focus.y - (focus.y - pan.y) * ratio };
}
