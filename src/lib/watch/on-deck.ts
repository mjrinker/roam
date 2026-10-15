/**
 * "Up next": for each show a profile has been watching, the next episode it hasn't seen. A show counts when the episode the profile finished
 * last is recent and nothing of that show is half-watched (that one is in Continue Watching already); the next episode is the first playable
 * one after the last one finished, in season and episode order, that isn't finished. A show with nothing left to watch has none.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, libraries, seasons, titles, watchState } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** How long ago the last finished episode can be for a show to still count. */
export const ON_DECK_DAYS = 120;

export interface OnDeckItem {
  showId: string;
  showName: string;
  showPosterUrl: string | null;
  showBackdropUrl: string | null;
  episodeId: string;
  season: number;
  number: number;
  name: string | null;
  stillUrl: string | null;
  /** When the profile finished the episode before it. */
  after: Date;
}

export async function onDeck(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; limit?: number; now?: Date }): Promise<OnDeckItem[]> {
  const limit = args.limit ?? 12;
  const since = new Date((args.now ?? new Date()).getTime() - ON_DECK_DAYS * 86_400_000);
  const access = and(eq(libraries.kind, "shows"), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges));

  // The episode each show was last finished at, newest show first.
  const last = await ex
    .selectDistinctOn([titles.id], { showId: titles.id, season: seasons.number, number: episodes.number, at: watchState.updatedAt })
    .from(watchState)
    .innerJoin(episodes, eq(episodes.id, watchState.ownerId))
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .innerJoin(titles, eq(titles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(watchState.viewerId, args.viewerId), eq(watchState.ownerKind, "episode"), eq(watchState.finished, true), gt(watchState.updatedAt, since), access))
    .orderBy(titles.id, desc(watchState.updatedAt));
  if (last.length === 0) return [];
  const showIds = last.map((l) => l.showId);

  // A show with an episode half-watched is Continue Watching's.
  const midway = await ex
    .select({ showId: seasons.titleId })
    .from(watchState)
    .innerJoin(episodes, eq(episodes.id, watchState.ownerId))
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(and(eq(watchState.viewerId, args.viewerId), eq(watchState.ownerKind, "episode"), eq(watchState.finished, false), gt(watchState.positionSeconds, 0), inArray(seasons.titleId, showIds)));
  const busy = new Set(midway.map((m) => m.showId));

  // Everything still to watch in these shows (with a file to play), in order.
  const todo = await ex
    .select({
      showId: titles.id,
      showName: titles.name,
      showPosterUrl: titles.posterUrl,
      showBackdropUrl: titles.backdropUrl,
      episodeId: episodes.id,
      season: seasons.number,
      number: episodes.number,
      name: episodes.name,
      stillUrl: episodes.stillUrl,
    })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .innerJoin(titles, eq(titles.id, seasons.titleId))
    .where(
      and(
        inArray(titles.id, showIds),
        sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'episode' AND m.owner_id = ${episodes.id})`,
        sql`NOT EXISTS (SELECT 1 FROM watch_state w WHERE w.owner_kind = 'episode' AND w.owner_id = ${episodes.id} AND w.viewer_id = ${args.viewerId} AND w.finished)`
      )
    )
    .orderBy(seasons.number, episodes.number);

  const out: OnDeckItem[] = [];
  for (const l of [...last].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    if (busy.has(l.showId)) continue;
    const next = todo.find((e) => e.showId === l.showId && (e.season > l.season || (e.season === l.season && e.number > l.number)));
    if (next) out.push({ ...next, after: l.at });
    if (out.length >= limit) break;
  }
  return out;
}
