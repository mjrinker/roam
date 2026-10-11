import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titleCast, titleCrew, titles } from "@/lib/db/schema";
import { CREW_LIMIT_DEFAULT, CREW_LIMIT_PER_JOB, crewRank, KEY_CREW_JOBS } from "@/lib/cast/crew-jobs";
import { getCredits, tmdbImageUrl, type TmdbCrewMember } from "@/lib/tmdb/client";

const BATCH_SIZE = 20;
/** How many of the billed cast are kept for a title. */
export const CAST_KEPT = 24;

/** The crew worth keeping: only the key jobs, a few people per job, each person once per job, most important job first. */
export function keyCrew(crew: TmdbCrewMember[]): TmdbCrewMember[] {
  const perJob = new Map<string, number>();
  const seen = new Set<string>();
  const kept = crew.filter((c) => {
    const job = c.job ?? "";
    if (!c.name || crewRank(job) >= KEY_CREW_JOBS.length || seen.has(`${c.id}:${job}`)) return false;
    const n = perJob.get(job) ?? 0;
    if (n >= (CREW_LIMIT_PER_JOB[job] ?? CREW_LIMIT_DEFAULT)) return false;
    perJob.set(job, n + 1);
    seen.add(`${c.id}:${job}`);
    return true;
  });
  return kept.sort((a, b) => crewRank(a.job!) - crewRank(b.job!));
}

/**
 * Fetches the billed cast and key crew from TMDB for movies and shows that have a TMDB match and none yet, a batch at a time, stopping at `deadline`.
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
      const credits = await getCredits(title.kind === "show" ? "show" : "movie", title.tmdbId as number);
      const cast = credits.cast.slice(0, CAST_KEPT);
      const crew = keyCrew(credits.crew);
      await db.transaction(async (tx) => {
        await tx.delete(titleCrew).where(eq(titleCrew.titleId, title.id));
        if (crew.length > 0) {
          await tx.insert(titleCrew).values(crew.map((c, position) => ({ titleId: title.id, personId: c.id, name: c.name, job: c.job!, photoUrl: tmdbImageUrl(c.profile_path, "w342"), position })));
        }
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
