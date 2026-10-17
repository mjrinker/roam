export type SortKey =
  | "title"
  | "author"
  | "year"
  | "added"
  | "duration"
  | "contentRating"
  | "imdb"
  | "rottenTomatoes"
  | "myRating";
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
  /** This profile's own rating in half stars (1 to 10); null when it has not rated this. */
  myRating?: number | null;
  /** The accounts that own a copy (of any season, for a show); only set on servers that track ownership. */
  ownerIds?: string[];
  /** The ids of this profile's own labels on it. */
  labelIds?: string[];
}

export const UNRATED = "Unrated";
/** The "My rating" filter choices: stars and up, any rating, or none yet. */
export const MINE_CHOICES: { value: string; label: string }[] = [
  { value: "4+", label: "4 stars and up" },
  { value: "3+", label: "3 stars and up" },
  { value: "rated", label: "Rated by me" },
  { value: "unrated", label: "Not rated by me" },
];
/** The owner filter's "nobody owns it" choice (not an account id). */
export const NO_OWNER = "none";

/** The name to alphabetize by: a leading "The " doesn't count. */
export function sortName(name: string): string {
  return name.trim().replace(/^the\s+(?=\S)/i, "");
}

/** Jump-rail buckets: "0" holds digits and anything else that isn't a Latin letter. */
export const RAIL_KEYS = ["0", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Which jump-rail bucket a name files under (ignoring a leading "The" and accents). */
export function letterKey(name: string): string {
  const first = sortName(name).normalize("NFD").charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "0";
}

export interface BrowseFilters {
  genres: ReadonlySet<string>;
  certifications: ReadonlySet<string>;
  /** Inclusive bounds in seconds; null means unbounded on that side. */
  minSeconds: number | null;
  maxSeconds: number | null;
  audioNeedsFix: boolean;
  /** Account ids, and/or NO_OWNER: titles owned by any of them, or by nobody. */
  owners: ReadonlySet<string>;
  /** Choices from MINE_CHOICES, OR'd: rated 4 stars or more, 3 or more, any rating, or not rated by this profile. */
  mine: ReadonlySet<string>;
  /** Label ids: titles under any of them. */
  labels: ReadonlySet<string>;
}

export const EMPTY_FILTERS: BrowseFilters = {
  genres: new Set(),
  certifications: new Set(),
  minSeconds: null,
  maxSeconds: null,
  audioNeedsFix: false,
  owners: new Set(),
  mine: new Set(),
  labels: new Set(),
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
  myRating: "desc",
};

export function activeFilterCount(f: BrowseFilters): number {
  return (
    (f.genres.size > 0 ? 1 : 0) +
    (f.certifications.size > 0 ? 1 : 0) +
    (f.minSeconds !== null || f.maxSeconds !== null ? 1 : 0) +
    (f.audioNeedsFix ? 1 : 0) +
    (f.owners.size > 0 ? 1 : 0) +
    (f.mine.size > 0 ? 1 : 0) +
    (f.labels.size > 0 ? 1 : 0)
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
    if (f.owners.size > 0) {
      const owned = i.ownerIds ?? [];
      if (owned.length === 0 ? !f.owners.has(NO_OWNER) : !owned.some((o) => f.owners.has(o))) return false;
    }
    if (f.mine.size > 0) {
      const mine = i.myRating ?? null;
      const ok = [...f.mine].some((c) => (c === "unrated" ? mine === null : c === "rated" ? mine !== null : mine !== null && mine >= Number(c.replace("+", "")) * 2));
      if (!ok) return false;
    }
    if (f.labels.size > 0 && !(i.labelIds ?? []).some((l) => f.labels.has(l))) return false;
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
    case "myRating":
      return item.myRating ?? null;
    default:
      return null;
  }
}

/** Sorts a copy. Items missing the sorted value always land last, whichever direction. */
export function sortItems<T extends BrowseItem>(items: readonly T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => sortName(a.name).localeCompare(sortName(b.name)) || a.name.localeCompare(b.name);
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
