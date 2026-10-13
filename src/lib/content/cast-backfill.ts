import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getMovieDetails, getTvShowDetails } from "@/lib/tmdb/cache";

const BATCH_SIZE = 20;

/**
 * Makes sure the shared TMDB entry (which holds a title's cast and crew) exists for movies and shows that have a TMDB match, a batch at a
 * time, stopping at `deadline`. Reading the entry fetches and stores it when no server has needed it yet. A title is stamped as asked
 * whatever the outcome (like the ratings backfills), so one TMDB can't answer for doesn't hold up the rest; Resync asks again.
 * Returns true when there may be more to do.
 */
export async function backfillCast(libraryId: string, deadline: number, onlyTitleId?: string): Promise<boolean> {
  const pending = await db
    .select({ id: titles.id, kind: titles.kind, tmdbId: titles.tmdbId })
    .from(titles)
    .where(
      and(
        eq(titles.libraryId, libraryId),
        inArray(titles.kind, ["movie", "show"]),
        sql`${titles.tmdbId} IS NOT NULL`,
        isNull(titles.castAttemptedAt),
        // Only titles whose shared entry isn't there yet need a fetch.
        sql`NOT EXISTS (SELECT 1 FROM tmdb_entries e WHERE e.tmdb_id = ${titles.tmdbId} AND e.kind = (CASE WHEN ${titles.kind} = 'movie' THEN 'movie' ELSE 'tv' END) AND e.season = 0 AND e.payload <> '{}'::jsonb)`,
        onlyTitleId ? eq(titles.id, onlyTitleId) : undefined
      )
    )
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    await db.update(titles).set({ castAttemptedAt: new Date() }).where(eq(titles.id, title.id));
    try {
      if (title.kind === "show") await getTvShowDetails(title.tmdbId as number);
      else await getMovieDetails(title.tmdbId as number);
    } catch (err) {
      console.warn(`TMDB lookup failed for title ${title.id}: ${(err as Error).message}`);
    }
  }
  return pending.length === BATCH_SIZE && !onlyTitleId;
}
