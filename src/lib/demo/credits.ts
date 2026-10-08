/**
 * The footage used on the public demo server, with where it came from and under what terms. The demo's movies
 * and shows carry real titles (and TMDB's posters and descriptions) but play THESE clips, so this list is how
 * the footage is credited. Filled in when the demo media is prepared (scripts/seed-demo-media.ts).
 */
export interface DemoClip {
  /** What the clip is. */
  title: string;
  /** Who made it / who holds the rights, as the licence asks it to be credited. */
  credit: string;
  /** Where it was obtained. */
  sourceUrl: string;
  /** "Public domain" or the licence's name and link. */
  license: string;
  licenseUrl?: string;
  /** The titles on the demo server that play this clip. */
  usedFor: string[];
}

export const DEMO_CLIPS: DemoClip[] = [];
