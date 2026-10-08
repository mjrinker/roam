import { demoCredits } from "@/lib/demo/catalog";

/**
 * The footage used on the public demo server, with where it came from and under what terms. The demo's movies
 * and shows carry real titles (and TMDB's posters and descriptions) but play THESE clips, so this list is how
 * the footage is credited. Derived from the same catalog the seeding script builds the media from.
 */
export interface DemoClip {
  title: string;
  credit: string;
  sourceUrl: string;
  license: string;
  licenseUrl?: string;
  usedFor: string[];
}

export const DEMO_CLIPS: DemoClip[] = demoCredits();
