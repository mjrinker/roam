/**
 * The shared TMDB cache. Every server asks for movie, show and season details through these functions, which read an entry from
 * tmdb_entries (fetched once, by whoever needed it first) and only call TMDB when there is none, or it is too old. TMDB's terms ask that
 * what is kept be refreshed within six months, so an entry older than FRESH_MS is refreshed in the background (on view, and by a daily
 * job for ones nobody views), and one that could not be refreshed by HARD_MS is cleared (clearExpired).
 *
 * Same signatures as the TMDB client's, so callers only change where they import from.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tmdbEntries } from "@/lib/db/schema";
import {
  getMovieDetails as fetchMovie,
  getSeasonEpisodes as fetchSeason,
  getTvShowDetails as fetchTv,
  TmdbHttpError,
  type TmdbEpisode,
  type TmdbMovieDetails,
  type TmdbTvDetails,
} from "@/lib/tmdb/client";
import { clearCredits, replaceCredits } from "@/lib/tmdb/credits-store";
import { clearProjection, projectMovie, projectSeason, projectShow } from "@/lib/tmdb/project";
import { trimEpisodes, trimMovie, trimTv } from "@/lib/tmdb/trim";

export const DAY_MS = 86_400_000;
/** Older than this, an entry is refreshed (about five months: a month of margin before TMDB's six). */
export const FRESH_MS = 150 * DAY_MS;
/** Older than this, an entry may not be kept or shown. */
export const HARD_MS = 183 * DAY_MS;

type Kind = "movie" | "tv" | "tv-season";
interface Key {
  kind: Kind;
  tmdbId: number;
  season: number;
}
const keyWhere = (k: Key) => and(eq(tmdbEntries.kind, k.kind), eq(tmdbEntries.tmdbId, k.tmdbId), eq(tmdbEntries.season, k.season));
const isEmpty = (p: Record<string, unknown> | null | undefined) => !p || Object.keys(p).length === 0;

async function loadRow(k: Key) {
  const [row] = await db.select().from(tmdbEntries).where(keyWhere(k)).limit(1);
  return row ?? null;
}

async function save(k: Key, payload: Record<string, unknown>, credits?: TmdbMovieDetails["credits"]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(tmdbEntries)
      .values({ ...k, payload, fetchedAt: new Date(), missingAt: null })
      .onConflictDoUpdate({ target: [tmdbEntries.kind, tmdbEntries.tmdbId, tmdbEntries.season], set: { payload, fetchedAt: new Date(), missingAt: null } });
    if (k.kind !== "tv-season") await replaceCredits(tx, k.kind, k.tmdbId, credits);
  });
}

/**
 * The entry's payload: the cached one when it is younger than HARD_MS (and `force` isn't set), else freshly fetched and stored. A failed
 * fetch falls back to a cached entry that is still within HARD_MS (not for a forced refresh, which reports the failure); TMDB saying it no
 * longer has the item is remembered.
 */
async function readThrough<T>(k: Key, force: boolean, fetcher: () => Promise<{ payload: Record<string, unknown>; credits?: TmdbMovieDetails["credits"] }>): Promise<T> {
  const row = await loadRow(k);
  const age = row ? Date.now() - row.fetchedAt.getTime() : Infinity;
  const usable = !!row && !isEmpty(row.payload) && age < HARD_MS;
  if (!force && usable) return row!.payload as T;
  try {
    const { payload, credits } = await fetcher();
    await save(k, payload, credits);
    return payload as T;
  } catch (err) {
    if (err instanceof TmdbHttpError && err.status === 404 && row) await db.update(tmdbEntries).set({ missingAt: new Date() }).where(keyWhere(k));
    // A forced refresh must say when it failed; any other read can fall back to what it has, while that is still allowed.
    if (usable && !force) return row!.payload as T;
    throw err;
  }
}

/** `append` is accepted for compatibility and ignored: an entry always holds ratings and credits. */
export function getMovieDetails(tmdbId: number, opts: { append?: string[]; force?: boolean } = {}): Promise<TmdbMovieDetails> {
  return readThrough<TmdbMovieDetails>({ kind: "movie", tmdbId, season: 0 }, !!opts.force, async () => {
    const full = await fetchMovie(tmdbId, { append: ["release_dates", "credits"] });
    return { payload: trimMovie(full) as unknown as Record<string, unknown>, credits: full.credits };
  });
}

export function getTvShowDetails(tmdbId: number, opts: { append?: string[]; force?: boolean } = {}): Promise<TmdbTvDetails> {
  return readThrough<TmdbTvDetails>({ kind: "tv", tmdbId, season: 0 }, !!opts.force, async () => {
    const full = await fetchTv(tmdbId, { append: ["content_ratings", "external_ids", "credits"] });
    return { payload: trimTv(full) as unknown as Record<string, unknown>, credits: full.credits };
  });
}

export async function getSeasonEpisodes(tmdbId: number, seasonNumber: number, opts: { force?: boolean } = {}): Promise<TmdbEpisode[]> {
  const entry = await readThrough<{ episodes: TmdbEpisode[] }>({ kind: "tv-season", tmdbId, season: seasonNumber }, !!opts.force, async () => ({ payload: trimEpisodes(await fetchSeason(tmdbId, seasonNumber)) }));
  return entry.episodes ?? [];
}

/** Whether an entry exists, is usable, and is older than FRESH_MS (so a view should refresh it in the background). */
export async function isStale(kind: "movie" | "tv", tmdbId: number): Promise<boolean> {
  const row = await loadRow({ kind, tmdbId, season: 0 });
  return !!row && !row.missingAt && Date.now() - row.fetchedAt.getTime() > FRESH_MS;
}

/**
 * For a page about this movie or show: if its entry is past FRESH_MS, refresh it now (so the page shows current details), but give up
 * waiting after `timeoutMs` so a slow TMDB can't hold the page up; the daily job picks up anything that didn't finish.
 */
export async function refreshIfStale(kind: "movie" | "tv", tmdbId: number, timeoutMs = 4000): Promise<void> {
  if (!(await isStale(kind, tmdbId))) return;
  await Promise.race([refreshEntry(kind, tmdbId), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Refreshes one movie or show from TMDB and pushes it to every title that uses it (with a show's seasons already in the cache).
 * "missing" means TMDB no longer has it; "failed" means it could not be reached (tried again next time).
 */
export async function refreshEntry(kind: "movie" | "tv", tmdbId: number): Promise<"refreshed" | "missing" | "failed"> {
  try {
    if (kind === "movie") {
      await projectMovie(db, tmdbId, await getMovieDetails(tmdbId, { force: true }));
    } else {
      await projectShow(db, tmdbId, await getTvShowDetails(tmdbId, { force: true }));
      const cached = await db.select({ season: tmdbEntries.season }).from(tmdbEntries).where(and(eq(tmdbEntries.kind, "tv-season"), eq(tmdbEntries.tmdbId, tmdbId)));
      for (const { season } of cached) await projectSeason(db, tmdbId, season, await getSeasonEpisodes(tmdbId, season, { force: true }).catch(() => []));
    }
    return "refreshed";
  } catch (err) {
    return err instanceof TmdbHttpError && err.status === 404 ? "missing" : "failed";
  }
}

/** Entries to refresh now: the oldest first, past FRESH_MS, skipping ones TMDB said it no longer has. */
export async function staleEntries(limit: number): Promise<{ kind: "movie" | "tv"; tmdbId: number }[]> {
  const rows = await db
    .select({ kind: tmdbEntries.kind, tmdbId: tmdbEntries.tmdbId })
    .from(tmdbEntries)
    .where(and(or(eq(tmdbEntries.kind, "movie"), eq(tmdbEntries.kind, "tv")), lt(tmdbEntries.fetchedAt, new Date(Date.now() - FRESH_MS)), isNull(tmdbEntries.missingAt)))
    .orderBy(tmdbEntries.fetchedAt)
    .limit(limit);
  return rows as { kind: "movie" | "tv"; tmdbId: number }[];
}

/** Removes entries (and their cast and crew) that no title on any server uses any more. */
export async function deleteUnreferencedEntries(): Promise<void> {
  await db.execute(sql`
    DELETE FROM tmdb_entries e WHERE NOT EXISTS (
      SELECT 1 FROM titles t WHERE t.tmdb_id = e.tmdb_id AND t.kind = (CASE WHEN e.kind = 'movie' THEN 'movie' ELSE 'show' END)::title_kind)`);
  for (const table of ["tmdb_cast", "tmdb_crew"]) {
    await db.execute(sql`
      DELETE FROM ${sql.raw(table)} c WHERE NOT EXISTS (
        SELECT 1 FROM titles t WHERE t.tmdb_id = c.tmdb_id AND t.kind = (CASE WHEN c.kind = 'movie' THEN 'movie' ELSE 'show' END)::title_kind)`);
  }
}

/**
 * The backstop: entries that could not be refreshed within HARD_MS are emptied, their cast and crew removed, and what came from them taken
 * off the titles that use them (see clearProjection). Returns how many entries it cleared.
 */
export async function clearExpired(): Promise<number> {
  const old = await db
    .select({ kind: tmdbEntries.kind, tmdbId: tmdbEntries.tmdbId, season: tmdbEntries.season, payload: tmdbEntries.payload })
    .from(tmdbEntries)
    .where(lt(tmdbEntries.fetchedAt, new Date(Date.now() - HARD_MS)));
  let cleared = 0;
  for (const e of old) {
    if (isEmpty(e.payload)) continue;
    await db.transaction(async (tx) => {
      await tx.update(tmdbEntries).set({ payload: {} }).where(keyWhere(e));
      if (e.kind !== "tv-season") await clearCredits(tx, e.kind, e.tmdbId);
      await clearProjection(tx, e.kind, e.tmdbId, e.season);
    });
    cleared++;
  }
  return cleared;
}

