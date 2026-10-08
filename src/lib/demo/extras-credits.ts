/**
 * Who made the photos, music, audiobooks and books on the public demo, and under what terms. The list is written by
 * scripts/seed-demo-extras.ts as it uploads and kept here as data; every entry was accepted only because its source said it was
 * public domain or CC0 (see open-sources.ts), and a test holds the list to that.
 */
import credits from "./extras-credits.json";

export interface ExtraCredit {
  library: "Photos" | "Music" | "Audiobooks" | "eBooks";
  name: string;
  author: string;
  licence: string;
  source: string;
}

export const EXTRAS_CREDITS = credits as ExtraCredit[];

export const EXTRAS_ORDER: ExtraCredit["library"][] = ["Music", "Audiobooks", "eBooks", "Photos"];

export function groupedCredits(list: ExtraCredit[] = EXTRAS_CREDITS) {
  return EXTRAS_ORDER.map((library) => ({ library, items: list.filter((c) => c.library === library) })).filter((g) => g.items.length > 0);
}
