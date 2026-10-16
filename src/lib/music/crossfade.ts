/**
 * Gapless playback and crossfade between the songs of a list: the rules for when the next song is got ready, when it takes over, and how
 * loud each is while they overlap. Pure (apart from the stored choice), so it is tested apart from the player.
 */

/** The crossfade lengths offered, in seconds (0 is off: songs still follow each other without a gap). */
export const CROSSFADE_CHOICES = [0, 2, 4, 6, 8, 10, 12] as const;
export const MAX_CROSSFADE_SECONDS = 12;

/** The next song is fetched and loaded this long before the current one ends (and at once for a song shorter than that). */
export const PREPARE_NEXT_SECONDS = 25;

/** Never start the hand-over this close to the end: there is nothing left to overlap. */
export const MIN_OVERLAP_SECONDS = 0.3;

/** A whole number of seconds from 0 to the most there is; anything else (a bad stored value) is off. */
export function clampCrossfade(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, Math.round(n)));
}

/** How long the overlap lasts for a song of this length: the chosen time, but never more than half the song (a short song is not all fade). */
export function overlapSeconds(crossfade: number, songSeconds: number): number {
  if (crossfade <= 0 || !(songSeconds > 0)) return 0;
  return Math.min(crossfade, songSeconds / 2);
}

/** Whether it is time to begin handing over to the next song: it has been prepared and what is left of this one is no more than the overlap. */
export function shouldHandOver(args: { crossfade: number; songSeconds: number; remainingSeconds: number }): boolean {
  const overlap = overlapSeconds(args.crossfade, args.songSeconds);
  return overlap > 0 && args.remainingSeconds <= overlap && args.remainingSeconds > MIN_OVERLAP_SECONDS;
}

/** Whether to be getting the next song ready: this one is nearly over. */
export function shouldPrepareNext(remainingSeconds: number): boolean {
  return remainingSeconds <= PREPARE_NEXT_SECONDS;
}

/** The volumes of the song going out and the one coming in, `progress` (0 to 1) of the way through the overlap. Equal power, so the sum doesn't dip. */
export function fadeGains(progress: number): { out: number; in: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { out: Math.cos((p * Math.PI) / 2), in: Math.sin((p * Math.PI) / 2) };
}

// ── The choice, kept on this device ──
const STORAGE_KEY = "roam.crossfadeSeconds";

export function readStoredCrossfade(): number {
  try {
    return clampCrossfade(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 0;
  }
}

export function storeCrossfade(seconds: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampCrossfade(seconds)));
  } catch {
    // private windows and blocked storage: the choice just lasts until the page closes
  }
}

/** Whether this device lets a page set an audio element's volume (iPhones and iPads do not, so they can play gaplessly but not overlap). */
export function volumeIsAdjustable(el: { volume: number }): boolean {
  const before = el.volume;
  try {
    el.volume = 0.5;
    const works = Math.abs(el.volume - 0.5) < 0.01;
    el.volume = before;
    return works;
  } catch {
    return false;
  }
}
