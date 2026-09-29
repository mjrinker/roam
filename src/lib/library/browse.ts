export type SortKey =
  | "title"
  | "author"
  | "year"
  | "added"
  | "duration"
  | "contentRating"
  | "imdb"
  | "rottenTomatoes";
export type SortDir = "asc" | "desc";

export interface BrowseItem {
  name: string;
  subtitle?: string | null;
  year: number | null;
  addedAtMs: number;
  genres: string[];
  runtimeSeconds: number | null;
  /** The certification shown for the viewer's country ("PG-13"), or null when unrated. */
  certification: string | null;
  /** That certification as a minimum age, used to order by content rating. */
  ratingAge: number | null;
  imdbRating: number | null;
  rottenTomatoesScore: number | null;
  needsAudioFix: boolean;
}

export const UNRATED = "Unrated";

export interface BrowseFilters {
  genres: ReadonlySet<string>;
  certifications: ReadonlySet<string>;
  /** Inclusive bounds in seconds; null means unbounded on that side. */
  minSeconds: number | null;
  maxSeconds: number | null;
  audioNeedsFix: boolean;
}

export const EMPTY_FILTERS: BrowseFilters = {
  genres: new Set(),
  certifications: new Set(),
  minSeconds: null,
  maxSeconds: null,
  audioNeedsFix: false,
};

export const DEFAULT_DIRECTION: Record<SortKey, SortDir> = {
  title: "asc",
  author: "asc",
  year: "desc",
  added: "desc",
  duration: "desc",
  contentRating: "asc",
  imdb: "desc",
  rottenTomatoes: "desc",
};

export function activeFilterCount(f: BrowseFilters): number {
  return (
    (f.genres.size > 0 ? 1 : 0) +
    (f.certifications.size > 0 ? 1 : 0) +
    (f.minSeconds !== null || f.maxSeconds !== null ? 1 : 0) +
    (f.audioNeedsFix ? 1 : 0)
  );
}

/** Genres and certifications within a filter are OR'd; different filters are AND'd. */
export function applyFilters<T extends BrowseItem>(items: readonly T[], f: BrowseFilters): T[] {
  return items.filter((i) => {
    if (f.genres.size > 0 && !i.genres.some((g) => f.genres.has(g))) return false;
    if (f.certifications.size > 0 && !f.certifications.has(i.certification ?? UNRATED)) return false;
    if (f.minSeconds !== null || f.maxSeconds !== null) {
      if (i.runtimeSeconds === null) return false;
      if (f.minSeconds !== null && i.runtimeSeconds < f.minSeconds) return false;
      if (f.maxSeconds !== null && i.runtimeSeconds > f.maxSeconds) return false;
    }
    if (f.audioNeedsFix && !i.needsAudioFix) return false;
    return true;
  });
}

function numeric(item: BrowseItem, key: SortKey): number | null {
  switch (key) {
    case "year":
      return item.year;
    case "added":
      return item.addedAtMs;
    case "duration":
      return item.runtimeSeconds;
    case "contentRating":
      return item.ratingAge;
    case "imdb":
      return item.imdbRating;
    case "rottenTomatoes":
      return item.rottenTomatoesScore;
    default:
      return null;
  }
}

/** Sorts a copy. Items missing the sorted value always land last, whichever direction. */
export function sortItems<T extends BrowseItem>(items: readonly T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...items].sort((a, b) => {
    if (key === "title") return sign * byName(a, b);
    if (key === "author") {
      const x = a.subtitle ?? null;
      const y = b.subtitle ?? null;
      if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
      return sign * x.localeCompare(y) || byName(a, b);
    }
    const x = numeric(a, key);
    const y = numeric(b, key);
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    return sign * (x - y) || byName(a, b);
  });
}
