/**
 * Turns TMDB certifications (and an Audible/Audnexus adult flag) into a
 * per-country **minimum age** so profiles can be restricted by rating
 * without caring which country's board issued it. Pure and side-effect
 * free; the scanner calls this after fetching TMDB details.
 *
 * `rating_ages` uses ISO 3166-1 country codes as keys, plus one synthetic
 * key `ANY` for content with no per-country certification at all (an
 * Audible adult/children's flag). See lib/content/access.ts for how a
 * profile's locale picks which key applies.
 */

export type RatingAges = Record<string, number>;
export type Certifications = Record<string, string>;

export interface ParsedRatings {
  /** Certification strings, for display (e.g. {US: "PG-13"}). */
  certifications: Certifications;
  /** The same, normalized to a minimum age. Omits certifications this module doesn't recognize. */
  ratingAges: RatingAges;
}

// Certification strings TMDB returns that mean "not actually rated".
const PLACEHOLDER_CERTS = new Set(["", "NR", "UR", "UNRATED", "NOT RATED", "E", "-", "UNKNOWN"]);

function cleanCertification(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toUpperCase() ?? "";
  return PLACEHOLDER_CERTS.has(trimmed) ? null : trimmed;
}

// Per-country certification -> minimum age. Movie and TV certifications share
// a table per country since the strings themselves don't collide.
const CERT_AGES: Record<string, Record<string, number>> = {
  US: {
    // Film (MPAA)
    G: 0,
    PG: 10,
    "PG-13": 13,
    R: 17,
    "NC-17": 18,
    // TV (TV Parental Guidelines)
    "TV-Y": 0,
    "TV-Y7": 7,
    "TV-Y7-FV": 7,
    "TV-G": 0,
    "TV-PG": 10,
    "TV-14": 13,
    "TV-MA": 17,
  },
  GB: { U: 0, UC: 0, PG: 8, "12": 12, "12A": 12, "15": 15, "18": 18, R18: 18 },
  CA: { G: 0, PG: 8, "14A": 14, "18A": 18, R: 18, A: 18, C: 0, C8: 8, "14+": 14, "18+": 18 },
  AU: { G: 0, P: 0, C: 0, PG: 8, M: 15, "M15+": 15, "MA15+": 15, "AV15+": 15, "R18+": 18, "X18+": 18 },
  DE: { "0": 0, "6": 6, "12": 12, "16": 16, "18": 18 },
  FR: { U: 0, TP: 0, "10": 10, "12": 12, "16": 16, "18": 18 },
  NL: { AL: 0, "6": 6, "9": 9, "12": 12, "14": 14, "16": 16, "18": 18 },
};

const GENERIC_AGE_RE = /^(\d{1,2})\+?$/;

/** The minimum age for one country's certification, or null if it isn't recognized. */
export function ageForCertification(country: string, certification: string): number | null {
  const known = CERT_AGES[country]?.[certification];
  if (known !== undefined) return known;
  const generic = GENERIC_AGE_RE.exec(certification);
  return generic ? Number(generic[1]) : null;
}

function toRatingAges(certifications: Certifications): RatingAges {
  const ages: RatingAges = {};
  for (const [country, cert] of Object.entries(certifications)) {
    const age = ageForCertification(country, cert);
    if (age !== null) ages[country] = age;
  }
  return ages;
}

// TMDB release_dates `type`: 1 premiere, 2 theatrical (limited), 3 theatrical,
// 4 digital, 5 physical, 6 TV. Prefer the widest/most standard release.
const RELEASE_TYPE_PRIORITY = [3, 2, 4, 5, 6, 1];

export interface TmdbReleaseDateEntry {
  certification?: string;
  type?: number;
}
export interface TmdbReleaseDatesResult {
  iso_3166_1: string;
  release_dates: TmdbReleaseDateEntry[];
}

/** From `movie/{id}?append_to_response=release_dates`'s `release_dates.results`. */
export function parseMovieCertifications(results: TmdbReleaseDatesResult[] | undefined): Certifications {
  const out: Certifications = {};
  for (const country of results ?? []) {
    for (const type of RELEASE_TYPE_PRIORITY) {
      const entry = country.release_dates.find((r) => r.type === type);
      const cert = cleanCertification(entry?.certification);
      if (cert) {
        out[country.iso_3166_1] = cert;
        break;
      }
    }
  }
  return out;
}

export interface TmdbContentRatingsResult {
  iso_3166_1: string;
  rating?: string;
}

/** From `tv/{id}?append_to_response=content_ratings`'s `content_ratings.results`. */
export function parseTvCertifications(results: TmdbContentRatingsResult[] | undefined): Certifications {
  const out: Certifications = {};
  for (const country of results ?? []) {
    const cert = cleanCertification(country.rating);
    if (cert) out[country.iso_3166_1] = cert;
  }
  return out;
}

/** Movie ratings from TMDB details (call with `getMovieDetails(id, {append: ["release_dates"]})`). */
export function ratingsFromMovieDetails(details: {
  adult?: boolean;
  release_dates?: { results: TmdbReleaseDatesResult[] };
}): ParsedRatings {
  const certifications = parseMovieCertifications(details.release_dates?.results);
  const ratingAges = toRatingAges(certifications);
  if (details.adult) ratingAges.ANY = Math.max(ratingAges.ANY ?? 0, 18);
  return { certifications, ratingAges };
}

/** TV ratings from TMDB details (call with `getTvShowDetails(id, {append: ["content_ratings"]})`). */
export function ratingsFromTvDetails(details: {
  content_ratings?: { results: TmdbContentRatingsResult[] };
}): ParsedRatings {
  const certifications = parseTvCertifications(details.content_ratings?.results);
  return { certifications, ratingAges: toRatingAges(certifications) };
}

/** Audiobooks have no per-country board; at most a coarse adult/children flag. */
/** The region subtag of a BCP-47 locale ("en-GB" -> "GB"), defaulting to US. */
export function countryFromLocale(locale: string | null | undefined): string {
  const region = locale?.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "US";
}

/** The certification to show for a viewer's country, falling back to US, then whatever's on file. */
export function displayCertification(
  certifications: Certifications | null | undefined,
  country: string
): string | null {
  if (!certifications) return null;
  return certifications[country] ?? certifications.US ?? Object.values(certifications)[0] ?? null;
}

export function ratingsForAudiobook(opts: { adult?: boolean; genres?: string[] }): ParsedRatings {
  if (opts.adult) return { certifications: {}, ratingAges: { ANY: 18 } };
  if (opts.genres?.some((g) => /child/i.test(g))) return { certifications: {}, ratingAges: { ANY: 0 } };
  return { certifications: {}, ratingAges: {} };
}
