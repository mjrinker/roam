/**
 * Film series ("Alien Collection") as collections: the TMDB collection each movie belongs to is read once per movie (backfillCollections),
 * and syncSeriesCollections turns what the titles say into collection rows and their members, so a series fills and empties by itself.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { titles, tmdbEntries } from "@/lib/db/schema";
import { projectMovie } from "@/lib/tmdb/project";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// Only the deadline really limits a pass; a title whose TMDB id was just handled (an extended edition of the same film) costs nothing.
const BATCH_SIZE = 150;

/**
 * Reads which collection each matched movie of a library belongs to, a batch at a time, stopping at `deadline`. An entry already stored
 * with the answer in it costs no TMDB call; an older one is fetched again once. A movie is stamped whatever the outcome, so one TMDB can't
 * answer for doesn't hold up the rest. Returns true when there may be more to do.
 */
export async function backfillCollections(ex: Db, libraryId: string, deadline: number): Promise<boolean> {
  const pending = await ex
    .select({ id: titles.id, tmdbId: titles.tmdbId })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "movie"), sql`${titles.tmdbId} IS NOT NULL`, inArray(titles.metadataStatus, ["matched", "manual"]), isNull(titles.collectionAttemptedAt)))
    .orderBy(sql`${titles.id} ASC`)
    .limit(BATCH_SIZE);
  // Loaded when needed: the cache talks to the shared database connection, which a list that only wants syncSeriesCollections has no use for.
  const { getMovieDetails, refreshEntry } = await import("@/lib/tmdb/cache");
  const done = new Set<number>();
  for (const title of pending) {
    if (Date.now() > deadline) return true;
    const tmdbId = title.tmdbId as number;
    if (done.has(tmdbId)) continue;
    done.add(tmdbId);
    try {
      const [entry] = await ex
        .select({ has: sql<boolean>`${tmdbEntries.payload} ? 'belongs_to_collection'` })
        .from(tmdbEntries)
        .where(and(eq(tmdbEntries.kind, "movie"), eq(tmdbEntries.tmdbId, tmdbId), eq(tmdbEntries.season, 0)))
        .limit(1);
      if (entry?.has) await projectMovie(ex, tmdbId, await getMovieDetails(tmdbId));
      else if ((await refreshEntry("movie", tmdbId)) !== "refreshed") await ex.update(titles).set({ collectionAttemptedAt: new Date() }).where(eq(titles.tmdbId, tmdbId));
    } catch (err) {
      console.warn(`TMDB collection lookup failed for title ${title.id}: ${(err as Error).message}`);
      await ex.update(titles).set({ collectionAttemptedAt: new Date() }).where(eq(titles.id, title.id));
    }
  }
  return pending.length === BATCH_SIZE;
}

/** Makes a library's film-series collections match its titles: a row per series, its members, and none left over for a series that is gone. */
export async function syncSeriesCollections(ex: Db, libraryId: string): Promise<void> {
  await ex.execute(sql`
    INSERT INTO collections (library_id, name, kind, tmdb_collection_id, poster_url)
    SELECT DISTINCT ON (t.collection_tmdb_id) t.library_id, t.collection_name, 'tmdb', t.collection_tmdb_id, t.collection_poster_url
    FROM titles t WHERE t.library_id = ${libraryId} AND t.kind = 'movie' AND t.collection_tmdb_id IS NOT NULL AND t.collection_name IS NOT NULL
    ORDER BY t.collection_tmdb_id, t.collection_poster_url IS NULL, t.name
    ON CONFLICT (library_id, tmdb_collection_id) DO UPDATE SET name = EXCLUDED.name, poster_url = COALESCE(EXCLUDED.poster_url, collections.poster_url)`);
  await ex.execute(sql`
    INSERT INTO collection_items (collection_id, title_id)
    SELECT c.id, t.id FROM titles t JOIN collections c ON c.library_id = t.library_id AND c.tmdb_collection_id = t.collection_tmdb_id
    WHERE t.library_id = ${libraryId} AND t.kind = 'movie'
    ON CONFLICT DO NOTHING`);
  await ex.execute(sql`
    DELETE FROM collection_items i USING collections c
    WHERE i.collection_id = c.id AND c.library_id = ${libraryId} AND c.kind = 'tmdb'
      AND NOT EXISTS (SELECT 1 FROM titles t WHERE t.id = i.title_id AND t.collection_tmdb_id = c.tmdb_collection_id)`);
  await ex.execute(sql`
    DELETE FROM collections c WHERE c.library_id = ${libraryId} AND c.kind = 'tmdb'
      AND NOT EXISTS (SELECT 1 FROM collection_items i WHERE i.collection_id = c.id)`);
}


/**
 * The same, for every movie library on every server, for the daily job and for catching up after the feature arrives: libraries are taken
 * one after another until `deadline`, and each one's collections are brought up to date. Returns true when there may be more to do.
 */
export async function catchUpCollections(ex: Db, deadline: number): Promise<boolean> {
  const libs = await ex
    .selectDistinct({ id: titles.libraryId })
    .from(titles)
    .where(and(eq(titles.kind, "movie"), sql`${titles.tmdbId} IS NOT NULL`, inArray(titles.metadataStatus, ["matched", "manual"]), isNull(titles.collectionAttemptedAt)));
  let more = false;
  for (const lib of libs) {
    if (Date.now() > deadline) return true;
    more = (await backfillCollections(ex, lib.id, deadline)) || more;
    await syncSeriesCollections(ex, lib.id);
  }
  return more || Date.now() > deadline;
}
