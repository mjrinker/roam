import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getOmdbRatings, isOmdbConfigured, OmdbRateLimitedError, OmdbUnavailableError } from "@/lib/omdb/client";
import { getMovieDetails, getTvShowDetails } from "@/lib/tmdb/client";

const BATCH_SIZE = 20;

/** A title matched before imdb_id was captured has a TMDB id but no IMDb id; ask TMDB for it. */
async function fetchImdbId(kind: "movie" | "show" | "audiobook", tmdbId: number): Promise<string | null> {
  if (kind === "movie") return (await getMovieDetails(tmdbId)).imdb_id ?? null;
  return (await getTvShowDetails(tmdbId, { append: ["external_ids"] })).external_ids?.imdb_id ?? null;
}

/**
 * Fetches IMDb rating + Rotten Tomatoes Tomatometer for movies/shows that
 * have a TMDB match but no OMDb data yet — looking up the IMDb id from TMDB
 * first for titles matched before that id was captured. A batch at a time,
 * stopping at `deadline`. A title OMDb genuinely has nothing for is stamped
 * "attempted" and left alone — same as lib/content/ratings-backfill — but a
 * rate limit or outage un-stamps the batch and stops the pass early, since
 * those are worth retrying on the next scan rather than giving up on.
 */
export async function backfillExternalRatings(libraryId: string, deadline: number, onlyTitleId?: string): Promise<boolean> {
  if (!isOmdbConfigured()) return false;

  const pending = await db
    .select({ id: titles.id, kind: titles.kind, tmdbId: titles.tmdbId, imdbId: titles.imdbId })
    .from(titles)
    .where(
      and(
        eq(titles.libraryId, libraryId),
        inArray(titles.kind, ["movie", "show"]),
        sql`(${titles.imdbId} IS NOT NULL OR ${titles.tmdbId} IS NOT NULL)`,
        isNull(titles.externalRatingsAttemptedAt),
        onlyTitleId ? eq(titles.id, onlyTitleId) : undefined
      )
    )
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    await db.update(titles).set({ externalRatingsAttemptedAt: new Date() }).where(eq(titles.id, title.id));

    try {
      let imdbId = title.imdbId;
      if (!imdbId) {
        imdbId = await fetchImdbId(title.kind, title.tmdbId as number);
        if (!imdbId) continue;
        await db.update(titles).set({ imdbId }).where(eq(titles.id, title.id));
      }
      const ratings = await getOmdbRatings(imdbId);
      await db
        .update(titles)
        .set({
          imdbRating: ratings?.imdbRating ?? null,
          imdbVotes: ratings?.imdbVotes ?? null,
          rottenTomatoesScore: ratings?.rottenTomatoesScore ?? null,
          metascore: ratings?.metascore ?? null,
        })
        .where(eq(titles.id, title.id));
    } catch (err) {
      if (err instanceof OmdbRateLimitedError || err instanceof OmdbUnavailableError) {
        // Transient: worth retrying, so undo the stamp and stop for this pass.
        await db.update(titles).set({ externalRatingsAttemptedAt: null }).where(eq(titles.id, title.id));
        console.warn(`OMDb unavailable, leaving ratings pending: ${(err as Error).message}`);
        return true;
      }
      console.warn(`External ratings backfill failed for title ${title.id}: ${(err as Error).message}`);
    }
  }
  return pending.length === BATCH_SIZE;
}
