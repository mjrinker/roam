/**
 * Marking things watched, listened to or read (and back) for one profile. This only writes the rows: who may mark what is decided by
 * the caller (see service.ts), which has already checked sharing and the age limit for the title, episode, season or show.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, seasons, watchState } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface Owner {
  ownerKind: "title" | "episode";
  ownerId: string;
  /** A length to remember with it, when known. */
  durationSeconds: number | null;
}

const CHUNK = 500;

/** Every episode of a show (or of one season of it), as things to mark. */
export async function episodeOwners(ex: Db, scope: { showId: string } | { seasonId: string }): Promise<Owner[]> {
  const rows = await ex
    .select({ id: episodes.id, runtimeSeconds: episodes.runtimeSeconds })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where("showId" in scope ? eq(seasons.titleId, scope.showId) : eq(episodes.seasonId, scope.seasonId));
  return rows.map((r) => ({ ownerKind: "episode", ownerId: r.id, durationSeconds: r.runtimeSeconds ?? null }));
}

/**
 * Marks the owners done (a finished row, keeping any length already known and putting the position at the end so it never looks half-way) or
 * not done (the row removed, so it no longer counts as started either). Returns how many owners were handled.
 */
export async function setDone(ex: Db, args: { viewerId: string; owners: Owner[]; done: boolean }): Promise<number> {
  const { viewerId, owners, done } = args;
  for (let i = 0; i < owners.length; i += CHUNK) {
    const chunk = owners.slice(i, i + CHUNK);
    if (done) {
      await ex
        .insert(watchState)
        .values(chunk.map((o) => ({ viewerId, ownerKind: o.ownerKind, ownerId: o.ownerId, positionSeconds: o.durationSeconds ?? 0, durationSeconds: o.durationSeconds, finished: true, updatedAt: new Date() })))
        .onConflictDoUpdate({
          target: [watchState.viewerId, watchState.ownerKind, watchState.ownerId],
          set: { finished: true, positionSeconds: sql`coalesce(${watchState.durationSeconds}, ${watchState.positionSeconds})`, updatedAt: new Date() },
        });
    } else {
      for (const kind of ["title", "episode"] as const) {
        const ids = chunk.filter((o) => o.ownerKind === kind).map((o) => o.ownerId);
        if (ids.length) await ex.delete(watchState).where(and(eq(watchState.viewerId, viewerId), eq(watchState.ownerKind, kind), inArray(watchState.ownerId, ids)));
      }
    }
  }
  return owners.length;
}
