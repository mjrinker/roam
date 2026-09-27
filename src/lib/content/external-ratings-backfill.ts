import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getOmdbRatings, isOmdbConfigured, OmdbRateLimitedError, OmdbUnavailableError } from "@/lib/omdb/client";

const BATCH_SIZE = 20;

/**
 * Fetches IMDb rating + Rotten Tomatoes Tomatometer for movies/shows that
 * have an IMDb id (from TMDB) but no OMDb data yet. A batch at a time,
 * stopping at `deadline`. A title OMDb genuinely has nothing for is stamped
 * "attempted" and left alone — same as lib/content/ratings-backfill — but a
 * rate limit or outage un-stamps the batch and stops the pass early, since
 * those are worth retrying on the next scan rather than giving up on.
 */
export async function backfillExternalRatings(libraryId: string, deadline: number): Promise<boolean> {
  if (!isOmdbConfigured()) return false;

  const pending = await db
    .select({ id: titles.id, imdbId: titles.imdbId })
    .from(titles)
    .where(
      and(
        eq(titles.libraryId, libraryId),
        inArray(titles.kind, ["movie", "show"]),
        sql`${titles.imdbId} IS NOT NULL`,
        isNull(titles.externalRatingsAttemptedAt)
      )
    )
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    await db.update(titles).set({ externalRatingsAttemptedAt: new Date() }).where(eq(titles.id, title.id));

    try {
      const ratings = await getOmdbRatings(title.imdbId as string);
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
