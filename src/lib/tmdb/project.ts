/**
 * Pushing a shared TMDB entry out to the titles and episodes that use it (every server's), and taking it back out when it expires. The
 * columns on titles and episodes are what lists and filters read (the age filter in particular); the entry is where they come from.
 * Titles whose match is still pending are left to the scan that matches them; an admin's own edits (name, year) are never touched.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ratingsFromMovieDetails, ratingsFromTvDetails } from "@/lib/content/ratings";
import { episodes, seasons, titles } from "@/lib/db/schema";
import { tmdbImageUrl, type TmdbEpisode, type TmdbMovieDetails, type TmdbTvDetails } from "@/lib/tmdb/client";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const MATCHED = ["matched", "manual"] as const;
const titleKind = (kind: "movie" | "tv") => (kind === "movie" ? "movie" : "show");

/** The collection columns of a movie from its entry (the entry says "none" with null; an old entry that was never asked leaves them alone). */
export function collectionColumns(d: TmdbMovieDetails) {
  const c = d.belongs_to_collection;
  return { collectionTmdbId: c?.id ?? null, collectionName: c?.name ?? null, collectionPosterUrl: tmdbImageUrl(c?.poster_path, "w342"), collectionAttemptedAt: new Date() };
}

/** The same for a title that was just matched: when the entry hasn't been asked yet, whatever an earlier match left is cleared and the backfill asks. */
export function collectionColumnsOnMatch(d: TmdbMovieDetails) {
  return d.belongs_to_collection !== undefined ? collectionColumns(d) : { collectionTmdbId: null, collectionName: null, collectionPosterUrl: null, collectionAttemptedAt: null };
}

/** Updates every matched movie (on any server) with this TMDB id from the entry. Returns how many titles it touched. */
export async function projectMovie(ex: Db, tmdbId: number, d: TmdbMovieDetails): Promise<number> {
  const { certifications, ratingAges } = ratingsFromMovieDetails(d);
  const rows = await ex
    .update(titles)
    .set({
      overview: d.overview ?? null,
      posterUrl: tmdbImageUrl(d.poster_path, "w500"),
      backdropUrl: tmdbImageUrl(d.backdrop_path, "w1280"),
      genres: d.genres?.map((g) => g.name) ?? [],
      certifications,
      ratingAges,
      ratingsAttemptedAt: new Date(),
      imdbId: d.imdb_id ?? null,
      ...(d.belongs_to_collection !== undefined ? collectionColumns(d) : {}),
      // OMDb's scores belong to an IMDb id: if it changed, they are fetched again.
      externalRatingsAttemptedAt: sql`CASE WHEN ${titles.imdbId} IS DISTINCT FROM ${d.imdb_id ?? null} THEN NULL ELSE ${titles.externalRatingsAttemptedAt} END`,
    })
    .where(and(eq(titles.tmdbId, tmdbId), eq(titles.kind, "movie"), inArray(titles.metadataStatus, [...MATCHED])))
    .returning({ id: titles.id });
  return rows.length;
}

export async function projectShow(ex: Db, tmdbId: number, d: TmdbTvDetails): Promise<number> {
  const { certifications, ratingAges } = ratingsFromTvDetails(d);
  const imdb = d.external_ids?.imdb_id ?? null;
  const rows = await ex
    .update(titles)
    .set({
      overview: d.overview ?? null,
      posterUrl: tmdbImageUrl(d.poster_path, "w500"),
      backdropUrl: tmdbImageUrl(d.backdrop_path, "w1280"),
      genres: d.genres?.map((g) => g.name) ?? [],
      certifications,
      ratingAges,
      ratingsAttemptedAt: new Date(),
      imdbId: imdb,
      externalRatingsAttemptedAt: sql`CASE WHEN ${titles.imdbId} IS DISTINCT FROM ${imdb} THEN NULL ELSE ${titles.externalRatingsAttemptedAt} END`,
    })
    .where(and(eq(titles.tmdbId, tmdbId), eq(titles.kind, "show"), inArray(titles.metadataStatus, [...MATCHED])))
    .returning({ id: titles.id });
  return rows.length;
}

/** Updates the episodes of every show with this TMDB id, for one season, from the entry (names an admin or the folder gave are kept). */
export async function projectSeason(ex: Db, showTmdbId: number, seasonNumber: number, tmdbEpisodes: TmdbEpisode[]): Promise<void> {
  if (tmdbEpisodes.length === 0) return;
  const rows = await ex
    .select({ id: episodes.id, number: episodes.number, name: episodes.name, runtimeSeconds: episodes.runtimeSeconds })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .where(and(eq(titles.tmdbId, showTmdbId), eq(titles.kind, "show"), eq(seasons.number, seasonNumber)));
  for (const ep of rows) {
    const t = tmdbEpisodes.find((e) => e.episode_number === ep.number);
    if (!t) continue;
    await ex
      .update(episodes)
      .set({ name: ep.name ?? t.name ?? null, tmdbId: t.id, overview: t.overview ?? null, stillUrl: tmdbImageUrl(t.still_path, "w500"), runtimeSeconds: t.runtime ? t.runtime * 60 : ep.runtimeSeconds })
      .where(eq(episodes.id, ep.id));
  }
}

/**
 * An entry that could not be refreshed in time: what came from it is taken off the titles. The age rating stays: it decides who may
 * see a title, and removing it would make a restricted title visible to everyone.
 */
export async function clearProjection(ex: Db, kind: "movie" | "tv" | "tv-season", tmdbId: number, season: number): Promise<void> {
  if (kind === "tv-season") {
    await ex.execute(sql`
      UPDATE ${episodes} SET overview = NULL, still_url = NULL
      FROM ${seasons}, ${titles}
      WHERE ${episodes.seasonId} = ${seasons.id} AND ${seasons.titleId} = ${titles.id}
        AND ${titles.tmdbId} = ${tmdbId} AND ${titles.kind} = 'show' AND ${seasons.number} = ${season}`);
    return;
  }
  await ex.update(titles).set({ overview: null, posterUrl: null, backdropUrl: null, genres: [], collectionTmdbId: null, collectionName: null, collectionPosterUrl: null, collectionAttemptedAt: null }).where(and(eq(titles.tmdbId, tmdbId), eq(titles.kind, titleKind(kind))));
}
