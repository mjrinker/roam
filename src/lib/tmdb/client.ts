/**
 * Minimal TMDB (The Movie Database) v3 REST client, authenticated with a v4
 * Read Access Token. Used by the scanner to auto-match titles and pull
 * posters/overviews. https://developer.themoviedb.org/reference
 */

import type { TmdbContentRatingsResult, TmdbReleaseDatesResult } from "@/lib/content/ratings";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

function getReadAccessToken(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_READ_ACCESS_TOKEN is not set");
  return token;
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
    throw new Error(`TMDB request failed: ${path} (${res.status})`);
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
  // Present only when fetched with `append: ["release_dates"]`.
  release_dates?: { results: TmdbReleaseDatesResult[] };
}

export interface TmdbTvDetails extends TmdbTvSearchResult {
  genres?: { id: number; name: string }[];
  number_of_seasons?: number;
  // Present only when fetched with `append: ["content_ratings"]`.
  content_ratings?: { results: TmdbContentRatingsResult[] };
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  name: string;
  overview?: string;
  still_path?: string | null;
  runtime?: number | null;
}

export function tmdbImageUrl(path: string | null | undefined, size: "w342" | "w500" | "w1280" | "original" = "w500"): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

export async function searchMovies(
  query: string,
  year: number | null = null
): Promise<TmdbMovieSearchResult[]> {
  const data = await tmdbFetch<{ results: TmdbMovieSearchResult[] }>("/search/movie", {
    query,
    year: year ?? undefined,
  });
  return data.results;
}

export async function searchMovie(title: string, year: number | null): Promise<TmdbMovieSearchResult | null> {
  const results = await searchMovies(title, year);
  return results[0] ?? null;
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

export async function searchTvShow(name: string, year: number | null): Promise<TmdbTvSearchResult | null> {
  const results = await searchTvShows(name, year);
  return results[0] ?? null;
}

export async function getTvShowDetails(
  tmdbId: number,
  opts: { append?: string[] } = {}
): Promise<TmdbTvDetails> {
  return tmdbFetch<TmdbTvDetails>(`/tv/${tmdbId}`, { append_to_response: opts.append });
}

export async function getSeasonEpisodes(tmdbId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
  const data = await tmdbFetch<{ episodes: TmdbEpisode[] }>(`/tv/${tmdbId}/season/${seasonNumber}`);
  return data.episodes ?? [];
}
