/**
 * Pure parser for OMDb (omdbapi.com) responses. OMDb aggregates a title's
 * IMDb rating and Rotten Tomatoes Tomatometer (critics' score) in one call
 * keyed by IMDb id — there is no free API for RT's audience score, so that
 * is never populated here.
 *
 * Real shape (undocumented beyond their site, so parsed defensively):
 * {
 *   "imdbID": "tt1477834", "imdbRating": "8.1", "imdbVotes": "1,234,567",
 *   "Ratings": [
 *     {"Source": "Internet Movie Database", "Value": "8.1/10"},
 *     {"Source": "Rotten Tomatoes", "Value": "87%"},
 *     {"Source": "Metacritic", "Value": "72/100"}
 *   ],
 *   "Response": "True"
 * }
 * A miss looks like {"Response": "False", "Error": "Movie not found!"}.
 */

export interface OmdbRatings {
  imdbRating: number | null;
  imdbVotes: number | null;
  /** Rotten Tomatoes Tomatometer, 0-100 (critics only — see module doc). */
  rottenTomatoesScore: number | null;
  metascore: number | null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** "8.1" -> 8.1; "N/A" or garbage -> null. */
function parseDecimal(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "1,234,567" -> 1234567. */
function parseVotes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "87%" -> 87. */
function parsePercent(v: unknown): number | null {
  const m = typeof v === "string" ? /^(\d{1,3})%$/.exec(v.trim()) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** "72/100" -> 72. */
function parseOutOf100(v: unknown): number | null {
  const m = typeof v === "string" ? /^(\d{1,3})\s*\/\s*100$/.exec(v.trim()) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

function findRating(ratings: unknown, source: string): string | undefined {
  if (!Array.isArray(ratings)) return undefined;
  const entry = ratings.find((r): r is Json => isObject(r) && r.Source === source);
  return typeof entry?.Value === "string" ? entry.Value : undefined;
}

/** Null means "not found" or an unrecognized shape (never throws — a miss is not an error). */
export function parseOmdbResponse(json: unknown): OmdbRatings | null {
  if (!isObject(json) || json.Response !== "True") return null;

  return {
    imdbRating: parseDecimal(json.imdbRating),
    imdbVotes: parseVotes(json.imdbVotes),
    rottenTomatoesScore: parsePercent(findRating(json.Ratings, "Rotten Tomatoes")),
    metascore: parseOutOf100(findRating(json.Ratings, "Metacritic")) ?? parseDecimal(json.Metascore),
  };
}
