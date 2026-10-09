/** Which subtitle track to switch on by itself: the language last chosen on this device, if the video has it. */

export interface TrackChoice {
  id: string;
  language: string;
  hearingImpaired: boolean;
}

/** What to remember when someone picks (or turns off) subtitles: "off", or the track's language. */
export const rememberedChoice = (track: TrackChoice | null): string => (track ? track.language : "off");

/**
 * The track to start with, given what was remembered: nothing for "off" or no memory; else a track in that language, preferring
 * one that isn't the hearing-impaired version unless that is all there is.
 */
export function pickInitialTrack<T extends TrackChoice>(tracks: readonly T[], remembered: string | null): T | null {
  if (!remembered || remembered === "off") return null;
  const wanted = remembered.toLowerCase();
  const same = tracks.filter((t) => t.language.toLowerCase() === wanted);
  // "pt" remembered and only "pt-BR" on offer (or the reverse) is still the language the person wanted.
  const loose = same.length ? same : tracks.filter((t) => t.language.toLowerCase().split("-")[0] === wanted.split("-")[0]);
  return loose.find((t) => !t.hearingImpaired) ?? loose[0] ?? null;
}

const KEY = "roam-subtitle-choice";

/** The remembered choice on this device (null when none, or when storage isn't available). */
export function readChoice(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeChoice(value: string, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try {
    storage?.setItem(KEY, value);
  } catch {
    // private browsing or blocked storage: the choice just isn't remembered
  }
}
