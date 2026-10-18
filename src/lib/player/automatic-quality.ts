/**
 * "Automatic" quality: the height to aim at when a title opens, from what this screen can show and what the connection can carry. The
 * server then plays the version closest to it. Pure, so the choice is tested without a browser; `conditionsNow` reads the real ones.
 */
export interface Conditions {
  /** The player's size in CSS pixels and the screen's pixel ratio. */
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  /** The browser's estimate of the connection (Chrome and Edge only; undefined elsewhere). */
  downlinkMbps?: number;
  effectiveType?: string;
  /** The browser's own data saver, or this profile's. */
  dataSaver?: boolean;
}

const SIZES = [144, 240, 360, 480, 720, 1080, 1440, 2160];

/**
 * The picture height worth sending: as many lines as the video can use on this screen (a 16:9 picture is limited by the shorter of the
 * height and the width), lowered for a slow or saving connection. Rounded to a usual size.
 */
export function automaticHeight(c: Conditions): number {
  const ratio = Math.max(1, Math.min(3, c.pixelRatio || 1));
  const usable = Math.min(c.viewportHeight, (c.viewportWidth * 9) / 16) * ratio;
  let cap = Infinity;
  if (c.dataSaver) cap = 480;
  if (c.effectiveType === "slow-2g" || c.effectiveType === "2g") cap = Math.min(cap, 240);
  else if (c.effectiveType === "3g") cap = Math.min(cap, 480);
  if (c.downlinkMbps !== undefined && c.downlinkMbps > 0) {
    // A picture of this many lines needs about this much, with room to spare.
    const fits = c.downlinkMbps < 1.5 ? 360 : c.downlinkMbps < 3 ? 480 : c.downlinkMbps < 6 ? 720 : Infinity;
    cap = Math.min(cap, fits);
  }
  const want = Math.min(usable, cap);
  // The usual size closest to what is wanted (the closest version is then chosen from the title's own).
  return SIZES.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), SIZES[0]);
}

/** The conditions as the browser reports them now. */
export function conditionsNow(dataSaver: boolean): Conditions {
  const c = (navigator as { connection?: { downlink?: number; effectiveType?: string; saveData?: boolean } }).connection;
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    downlinkMbps: c?.downlink,
    effectiveType: c?.effectiveType,
    dataSaver: dataSaver || c?.saveData === true,
  };
}
