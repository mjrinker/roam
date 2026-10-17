/**
 * Counting how long a household watches. The player saves where it has got to every so often; the time to count for a save is how far the
 * position moved forward, limited by the time that really passed (at up to 4x speed) and by a ceiling, so jumping ahead in a video or coming back
 * from a long pause does not add up to hours that were not spent watching. It is an estimate, and says so where it is shown.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The fastest playback that is counted as real time spent. */
export const MAX_SPEED = 4;
/** The most counted from one save. */
export const MAX_PER_SAVE_SECONDS = 180;

/** Whole seconds to add for a save at `positionSeconds`, given the save before it (none: nothing, since where the viewing began is not known). */
export function secondsWatched(prev: { positionSeconds: number; savedAt: Date } | null, positionSeconds: number, now: Date): number {
  if (!prev) return 0;
  const moved = positionSeconds - prev.positionSeconds;
  const real = (now.getTime() - prev.savedAt.getTime()) / 1000;
  if (!(moved > 0) || !(real > 0)) return 0;
  return Math.max(0, Math.floor(Math.min(moved, real * MAX_SPEED, MAX_PER_SAVE_SECONDS)));
}

/** The UTC day of a moment, as 2026-10-17. */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Adds seconds to a household's day for a title (an episode counts for its show). Returns without touching anything for no time, or for an id
 * that is not on this server.
 */
export async function recordWatch(ex: Db, args: { serverId: string; accountId: string; ownerKind: "title" | "episode"; ownerId: string; seconds: number; now?: Date }): Promise<void> {
  if (args.seconds < 1) return;
  const day = dayOf(args.now ?? new Date());
  await ex.execute(sql`
    INSERT INTO watch_activity (server_id, account_id, day, title_id, seconds)
    SELECT l.server_id, ${args.accountId}::uuid, ${day}::date, t.id, ${args.seconds}
    FROM ${args.ownerKind === "title"
      ? sql`titles t JOIN libraries l ON l.id = t.library_id WHERE t.id = ${args.ownerId}::uuid`
      : sql`episodes e JOIN seasons sn ON sn.id = e.season_id JOIN titles t ON t.id = sn.title_id JOIN libraries l ON l.id = t.library_id WHERE e.id = ${args.ownerId}::uuid`}
      AND l.server_id = ${args.serverId}::uuid
    ON CONFLICT (server_id, account_id, day, title_id) DO UPDATE SET seconds = watch_activity.seconds + EXCLUDED.seconds`);
}
