/**
 * What Roam keeps of a TMDB response: only the parts it uses, so a shared entry is a few kilobytes rather than the hundreds a full
 * response (every country's release dates, the whole cast and crew) would be. Credits are stored as rows (credits-store), not here.
 */
import type { TmdbEpisode, TmdbMovieDetails, TmdbTvDetails } from "@/lib/tmdb/client";

export function trimMovie(d: TmdbMovieDetails): TmdbMovieDetails {
  return {
    id: d.id,
    title: d.title,
    release_date: d.release_date,
    overview: d.overview,
    poster_path: d.poster_path,
    backdrop_path: d.backdrop_path,
    runtime: d.runtime,
    genres: d.genres?.map((g) => ({ id: g.id, name: g.name })),
    adult: d.adult,
    imdb_id: d.imdb_id,
    // Always written (null when there is none), so an entry that has the key has been asked.
    belongs_to_collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name, poster_path: d.belongs_to_collection.poster_path ?? null } : null,
    release_dates: d.release_dates
      ? { results: d.release_dates.results.map((r) => ({ iso_3166_1: r.iso_3166_1, release_dates: r.release_dates.map((x) => ({ certification: x.certification, type: x.type })) })) }
      : undefined,
  };
}

export function trimTv(d: TmdbTvDetails): TmdbTvDetails {
  return {
    id: d.id,
    name: d.name,
    first_air_date: d.first_air_date,
    overview: d.overview,
    poster_path: d.poster_path,
    backdrop_path: d.backdrop_path,
    genres: d.genres?.map((g) => ({ id: g.id, name: g.name })),
    number_of_seasons: d.number_of_seasons,
    content_ratings: d.content_ratings ? { results: d.content_ratings.results.map((r) => ({ iso_3166_1: r.iso_3166_1, rating: r.rating })) } : undefined,
    external_ids: d.external_ids ? { imdb_id: d.external_ids.imdb_id } : undefined,
  };
}

export function trimEpisodes(episodes: TmdbEpisode[]): { episodes: TmdbEpisode[] } {
  return { episodes: episodes.map((e) => ({ id: e.id, episode_number: e.episode_number, name: e.name, overview: e.overview, still_path: e.still_path, runtime: e.runtime })) };
}
