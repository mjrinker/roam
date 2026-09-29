/**
 * Picks the right TMDB search hit for a folder's "Name (Year)". TMDB orders
 * by popularity, so without this an older, more famous film with the same
 * title (The Kid 1921 vs The Kid 2000) beats the one the year asks for.
 */

export interface MatchCandidate {
  title: string;
  year: number | null;
}

export function yearOf(date: string | undefined | null): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Best candidate for `title`/`year`, keeping TMDB's order as the tiebreak.
 * With a year: exact year beats ±1 (folder years are sometimes a release
 * off), and an exact title match beats a fuzzy one within the same year
 * distance. Returns null when nothing is within a year of the request —
 * except an exact-title hit, kept as a last resort so a slightly wrong
 * folder year doesn't lose the match. Without a year, TMDB's top hit wins.
 */
export function pickBestMatch<T>(
  results: readonly T[],
  title: string,
  year: number | null,
  read: (r: T) => MatchCandidate
): T | null {
  if (results.length === 0) return null;
  if (year == null) return results[0];

  const wanted = normalizeTitle(title);
  let best: { item: T; score: number } | null = null;
  let exactTitleFallback: T | null = null;

  for (const item of results) {
    const c = read(item);
    const exactTitle = normalizeTitle(c.title) === wanted;
    if (exactTitle && exactTitleFallback === null) exactTitleFallback = item;
    if (c.year == null) continue;
    const distance = Math.abs(c.year - year);
    if (distance > 1) continue;
    const score = (distance === 0 ? 2 : 0) + (exactTitle ? 1 : 0);
    if (!best || score > best.score) best = { item, score };
  }

  return best?.item ?? exactTitleFallback;
}
