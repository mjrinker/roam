import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titleCast, titles } from "@/lib/db/schema";
import { getCredits, tmdbImageUrl } from "@/lib/tmdb/client";

const BATCH_SIZE = 20;
/** How many of the billed cast are kept for a title. */
export const CAST_KEPT = 24;

/**
 * Fetches the billed cast from TMDB for movies and shows that have a TMDB match and none yet, a batch at a time, stopping at `deadline`.
 * A title is stamped as asked whatever the outcome (like the ratings backfills), so one that TMDB can't answer for doesn't hold up the
 * rest; Resync on the title asks again. Returns true when there may be more to do.
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
        onlyTitleId ? eq(titles.id, onlyTitleId) : undefined
      )
    )
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    await db.update(titles).set({ castAttemptedAt: new Date() }).where(eq(titles.id, title.id));
    try {
      const cast = (await getCredits(title.kind === "show" ? "show" : "movie", title.tmdbId as number)).slice(0, CAST_KEPT);
      await db.transaction(async (tx) => {
        await tx.delete(titleCast).where(eq(titleCast.titleId, title.id));
        const seen = new Set<number>();
        const rows = cast
          .filter((c) => c.name && !seen.has(c.id) && (seen.add(c.id), true))
          .map((c, position) => ({ titleId: title.id, personId: c.id, name: c.name, character: c.character?.trim() || null, photoUrl: tmdbImageUrl(c.profile_path, "w342"), position }));
        if (rows.length > 0) await tx.insert(titleCast).values(rows);
      });
    } catch (err) {
      console.warn(`Cast lookup failed for title ${title.id}: ${(err as Error).message}`);
    }
  }
  return pending.length === BATCH_SIZE && !onlyTitleId;
}
