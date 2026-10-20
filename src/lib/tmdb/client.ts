/**
 * Minimal TMDB (The Movie Database) v3 REST client, authenticated with a v4
 * Read Access Token. Used by the scanner to auto-match titles and pull
 * posters/overviews. https://developer.themoviedb.org/reference
 */

import type { TmdbContentRatingsResult, TmdbReleaseDatesResult } from "@/lib/content/ratings";
import { pickBestMatch, yearOf } from "@/lib/tmdb/match";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

function getReadAccessToken(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_READ_ACCESS_TOKEN is not set");
  return token;
}

/** TMDB answered with an error status. A 404 means it no longer has (or never had) that item. */
export class TmdbHttpError extends Error {
  constructor(
    path: string,
    public readonly status: number
  ) {
    super(`TMDB request failed: ${path} (${status})`);
    this.name = "TmdbHttpError";
  }
}

async function tmdbFetch<T>(
  path: string,
  params: Record<string, string | number | string[] | undefined> = {}
): Promise<T> {
  const url = new URL(`${TMDB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getReadAccessToken()}`,
      accept: "application/json",
    },
    // Metadata doesn't change often; a short revalidation window is plenty.
    next: { revalidate: 60 * 60 * 24 },
  });

  if (!res.ok) {
    throw new TmdbHttpError(path, res.status);
  }
  return res.json();
}

export interface TmdbMovieSearchResult {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbTvSearchResult {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbMovieDetails extends TmdbMovieSearchResult {
  runtime?: number | null;
  genres?: { id: number; name: string }[];
  adult?: boolean;
  // Already on the base movie response — no append_to_response needed.
  imdb_id?: string | null;
  // The film series this belongs to (null when none; absent when the entry was stored before Roam asked).
  belongs_to_collection?: { id: number; name: string; poster_path?: string | null; backdrop_path?: string | null } | null;
  // Present only when fetched with `append: ["release_dates"]`.
  release_dates?: { results: TmdbReleaseDatesResult[] };
  // Present only when fetched with `append: ["credits"]`.
  credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] };
}

export interface TmdbTvDetails extends TmdbTvSearchResult {
  genres?: { id: number; name: string }[];
  number_of_seasons?: number;
  // Present only when fetched with `append: ["content_ratings"]`.
  content_ratings?: { results: TmdbContentRatingsResult[] };
  // Present only when fetched with `append: ["external_ids"]` — unlike
  // movies, a TV show's imdb_id isn't on the base response.
  external_ids?: { imdb_id?: string | null };
  // Present only when fetched with `append: ["credits"]`.
  credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] };
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  name: string;
  overview?: string;
  still_path?: string | null;
  runtime?: number | null;
  /** "YYYY-MM-DD": what a date-named episode file is matched on. */
  air_date?: string | null;
}

export function tmdbImageUrl(path: string | null | undefined, size: "w342" | "w500" | "w1280" | "original" = "w500"): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

export async function searchMovies(
  query: string,
  year: number | null = null
): Promise<TmdbMovieSearchResult[]> {
  // primary_release_year is the ORIGINAL release; plain `year` also matches
  // re-releases, which lets an old classic's reissue win.
  const data = await tmdbFetch<{ results: TmdbMovieSearchResult[] }>("/search/movie", {
    query,
    primary_release_year: year ?? undefined,
  });
  return data.results;
}

const readMovie = (r: TmdbMovieSearchResult) => ({ title: r.title, year: yearOf(r.release_date) });

export async function searchMovie(title: string, year: number | null): Promise<TmdbMovieSearchResult | null> {
  if (year == null) return (await searchMovies(title))[0] ?? null;
  const exact = pickBestMatch(await searchMovies(title, year), title, year, readMovie);
  if (exact) return exact;
  // The folder year may be a release off, or TMDB filed it under another
  // year — look through the unfiltered results before giving up.
  return pickBestMatch(await searchMovies(title), title, year, readMovie);
}

export async function getMovieDetails(
  tmdbId: number,
  opts: { append?: string[] } = {}
): Promise<TmdbMovieDetails> {
  return tmdbFetch<TmdbMovieDetails>(`/movie/${tmdbId}`, { append_to_response: opts.append });
}

export async function searchTvShows(
  query: string,
  year: number | null = null
): Promise<TmdbTvSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbTvSearchResult[] }>("/search/tv", {
    query,
    first_air_date_year: year ?? undefined,
  });
  return data.results;
}

const readShow = (r: TmdbTvSearchResult) => ({ title: r.name, year: yearOf(r.first_air_date) });

export async function searchTvShow(name: string, year: number | null): Promise<TmdbTvSearchResult | null> {
  if (year == null) return (await searchTvShows(name))[0] ?? null;
  const exact = pickBestMatch(await searchTvShows(name, year), name, year, readShow);
  if (exact) return exact;
  return pickBestMatch(await searchTvShows(name), name, year, readShow);
}

export async function getTvShowDetails(
  tmdbId: number,
  opts: { append?: string[] } = {}
): Promise<TmdbTvDetails> {
  return tmdbFetch<TmdbTvDetails>(`/tv/${tmdbId}`, { append_to_response: opts.append });
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string | null;
  profile_path?: string | null;
  order?: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job?: string | null;
  department?: string | null;
  profile_path?: string | null;
}

export interface TmdbCombinedCredit {
  id: number;
  media_type: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  character?: string | null;
  job?: string | null;
  popularity?: number;
  genre_ids?: number[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography?: string | null;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  combined_credits?: { cast?: TmdbCombinedCredit[]; crew?: TmdbCombinedCredit[] };
}

/** A person's bio and everything they are credited on (movies and shows), in one call. */
export async function getPerson(personId: number): Promise<TmdbPerson> {
  return tmdbFetch<TmdbPerson>(`/person/${personId}`, { append_to_response: ["combined_credits"] });
}

export async function getSeasonEpisodes(tmdbId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
  const data = await tmdbFetch<{ episodes: TmdbEpisode[] }>(`/tv/${tmdbId}/season/${seasonNumber}`);
  return data.episodes ?? [];
}

/** Resolves a TheTVDB series id ({tvdb-73244} in a folder name) to TMDB's show id; null when TMDB has none. */
export async function findTmdbShowIdByTvdbId(tvdbId: number): Promise<number | null> {
  const data = await tmdbFetch<{ tv_results?: { id: number }[] }>(`/find/${tvdbId}`, { external_source: "tvdb_id" });
  return data.tv_results?.[0]?.id ?? null;
}

/**
 * Resolves an IMDb id (tt0167260) to TMDB's id via /find. Null when TMDB
 * has no entry of that kind for it.
 */
export async function findTmdbIdByImdbId(imdbId: string, kind: "movie" | "show"): Promise<number | null> {
  const data = await tmdbFetch<{ movie_results?: { id: number }[]; tv_results?: { id: number }[] }>(
    `/find/${encodeURIComponent(imdbId)}`,
    { external_source: "imdb_id" }
  );
  const hits = kind === "movie" ? data.movie_results : data.tv_results;
  return hits?.[0]?.id ?? null;
}
