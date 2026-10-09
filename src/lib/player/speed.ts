/** Playback speed: the choices, and turning what someone typed into a speed the player accepts. */

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 3;
export const SPEED_STEP = 0.25;

/** 0.25x, 0.5x ... 3x: every step in the menu. */
export const SPEED_PRESETS: readonly number[] = Array.from({ length: Math.round((SPEED_MAX - SPEED_MIN) / SPEED_STEP) + 1 }, (_, i) => SPEED_MIN + i * SPEED_STEP);

/** A speed kept inside the allowed range and rounded to two places (a bad value becomes normal speed). */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(speed * 100) / 100));
}

/** Whether this is a speed the app allows (for storing a library's default). */
export const isValidSpeed = (speed: unknown): speed is number => typeof speed === "number" && Number.isFinite(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX;

/**
 * What someone typed as a custom speed: "1.35", "1,35" and "1.5x" all work. Null when it isn't a number or is outside
 * 0.25 to 3 (the caller shows a message rather than guessing).
 */
export function parseSpeedInput(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/x$/, "").trim().replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < SPEED_MIN - 1e-9 || n > SPEED_MAX + 1e-9) return null;
  return clampSpeed(n);
}

/** "1x", "1.25x", "0.25x": no trailing zeros. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}
