/** Reading a profile's watch list, and taking finished things off it. Pure queries (they take the database), so mark.ts and the pages can use them. */
import { hasPlayableFile } from "@/lib/content/playable";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, titles, watchlistItems } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { WATCHLIST_KINDS, type WatchlistKind } from "./kinds";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Whether each of the given titles is on this profile's watch list. */
export async function onWatchlist(ex: Db, viewerId: string, titleIds: string[]): Promise<Set<string>> {
  if (titleIds.length === 0) return new Set();
  const rows = await ex.select({ id: watchlistItems.titleId }).from(watchlistItems).where(and(eq(watchlistItems.viewerId, viewerId), inArray(watchlistItems.titleId, titleIds)));
  return new Set(rows.map((r) => r.id));
}

export interface WatchlistEntry {
  id: string;
  kind: WatchlistKind;
  name: string;
  year: number | null;
  posterUrl: string | null;
  addedAt: Date;
}

/** This profile's watch list, most recently added first, with only what it may see (library access and age limit). */
export async function listWatchlist(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; serverId: string; limit?: number }): Promise<WatchlistEntry[]> {
  const rows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl, addedAt: watchlistItems.addedAt })
    .from(watchlistItems)
    .innerJoin(titles, eq(titles.id, watchlistItems.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(watchlistItems.viewerId, args.viewerId), eq(libraries.serverId, args.serverId), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind)))
    .orderBy(desc(watchlistItems.addedAt), sql`lower(${titles.name})`)
    .limit(args.limit ?? 500);
  return rows.filter((r): r is typeof r & { kind: WatchlistKind } => (WATCHLIST_KINDS as readonly string[]).includes(r.kind));
}

/**
 * Takes finished things off the watch list: a movie or audiobook that was finished, and a show once every one of its episodes has been.
 * Pass what was just finished; nothing else on the list is touched.
 */
export async function dropFinished(ex: Db, viewerId: string, done: { titleIds?: string[]; episodeIds?: string[] }): Promise<void> {
  if (done.titleIds?.length) await ex.delete(watchlistItems).where(and(eq(watchlistItems.viewerId, viewerId), inArray(watchlistItems.titleId, done.titleIds)));
  if (done.episodeIds?.length) {
    const ids = sql.join(done.episodeIds.map((id) => sql`${id}::uuid`), sql`, `);
    await ex.execute(sql`
      DELETE FROM watchlist_items w
      WHERE w.viewer_id = ${viewerId}
        AND w.title_id IN (SELECT sn.title_id FROM episodes e JOIN seasons sn ON sn.id = e.season_id WHERE e.id IN (${ids}))
        AND NOT EXISTS (
          SELECT 1 FROM episodes e2 JOIN seasons s2 ON s2.id = e2.season_id
          WHERE s2.title_id = w.title_id
            AND NOT EXISTS (SELECT 1 FROM watch_state ws WHERE ws.viewer_id = w.viewer_id AND ws.owner_kind = 'episode' AND ws.owner_id = e2.id AND ws.finished)
        )`);
  }
}
