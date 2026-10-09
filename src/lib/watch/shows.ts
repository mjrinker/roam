import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, mediaFiles, seasons, watchState } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Which of these shows a profile has watched all the way through: it has playable episodes (ones with a media file, so a gap in the
 * collection doesn't stop a show ever counting), and every one is finished or marked watched.
 */
export async function watchedShowIds(ex: Db, viewerId: string, showIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (showIds.length === 0) return out;
  const counts = await ex
    .select({
      showId: seasons.titleId,
      total: sql<number>`count(${episodes.id})::int`,
      done: sql<number>`count(${watchState.id}) filter (where ${watchState.finished})::int`,
    })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .leftJoin(watchState, and(eq(watchState.ownerKind, "episode"), eq(watchState.ownerId, episodes.id), eq(watchState.viewerId, viewerId)))
    .where(and(inArray(seasons.titleId, showIds), sql`EXISTS (SELECT 1 FROM ${mediaFiles} m WHERE m.owner_kind = 'episode' AND m.owner_id = ${episodes.id})`))
    .groupBy(seasons.titleId);
  for (const c of counts) if (c.total > 0 && c.done === c.total) out.add(c.showId);
  return out;
}
