import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getMovieDetails, getTvShowDetails } from "@/lib/tmdb/client";
import { ratingsFromMovieDetails, ratingsFromTvDetails } from "@/lib/content/ratings";

const BATCH_SIZE = 20;

/**
 * Fetches ratings for already-matched movies/shows that predate this feature
 * (or whose first fetch failed). Modeled on enrichPendingAudiobooks: a batch
 * at a time, least-recently-tried first, stopping at `deadline` and leaving
 * the rest for a later pass. Until this runs, an existing title has no
 * rating_ages and so counts as unrated (see lib/content/access).
 */
export async function backfillRatings(libraryId: string, deadline: number): Promise<boolean> {
  const pending = await db
    .select({ id: titles.id, kind: titles.kind, tmdbId: titles.tmdbId })
    .from(titles)
    .where(
      and(
        eq(titles.libraryId, libraryId),
        inArray(titles.kind, ["movie", "show"]),
        sql`${titles.tmdbId} IS NOT NULL`,
        isNull(titles.ratingsAttemptedAt)
      )
    )
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    // Stamped before the fetch, same reasoning as metadataAttemptedAt: a
    // title whose fetch throws still isn't retried every single pass.
    await db.update(titles).set({ ratingsAttemptedAt: new Date() }).where(eq(titles.id, title.id));
    try {
      const { certifications, ratingAges } =
        title.kind === "movie"
          ? ratingsFromMovieDetails(await getMovieDetails(title.tmdbId as number, { append: ["release_dates"] }))
          : ratingsFromTvDetails(await getTvShowDetails(title.tmdbId as number, { append: ["content_ratings"] }));
      await db.update(titles).set({ certifications, ratingAges }).where(eq(titles.id, title.id));
    } catch (err) {
      console.warn(`Ratings backfill failed for title ${title.id}: ${(err as Error).message}`);
    }
  }
  return pending.length === BATCH_SIZE;
}
