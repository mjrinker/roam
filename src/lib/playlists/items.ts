/**
 * The ONLY place playlist items are read. Every query joins an item to its
 * library and keeps the viewing profile's age restrictions (`contentFilter`)
 * IN SQL, so items a profile may not watch are simply absent: pages, cursors
 * and counts never reveal them. Episode items are rated by their show.
 */
import { and, asc, count, eq, gt, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { episodes, libraries, playlistItems, seasons, titles } from "@/lib/db/schema";
import type { Executor } from "./executor";

const showTitles = alias(titles, "show_titles");

// An item's title is the title itself, or the show an episode belongs to.
const effectiveLibraryId = sql`coalesce(${titles.libraryId}, ${showTitles.libraryId})`;
const effectiveRatingAges = sql`coalesce(${titles.ratingAges}, ${showTitles.ratingAges})`;

export interface PlaylistItemView {
  id: string;
  position: number;
  titleId: string | null;
  episodeId: string | null;
  /** The title's kind (movie|show|audiobook), or null for an episode item. */
  titleKind: "movie" | "show" | "audiobook" | null;
  name: string | null;
  year: number | null;
  posterUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  showName: string | null;
  showId: string | null;
}

export interface ItemCursor {
  position: number;
  id: string;
}

export interface ItemsPage {
  items: PlaylistItemView[];
  /** Pass back as `after` for the next page; null when this was the last page. */
  nextCursor: ItemCursor | null;
}

/** One page of the items this viewer may see, in playlist order. `limit` is the page size (capped at 200). */
export async function listVisibleItems(
  ex: Executor,
  args: { playlistId: string; serverId: string; viewer: AccessProfile; limit?: number; after?: ItemCursor | null }
): Promise<ItemsPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const rows = await ex
    .select({
      id: playlistItems.id,
      position: playlistItems.position,
      titleId: playlistItems.titleId,
      episodeId: playlistItems.episodeId,
      titleKind: titles.kind,
      titleName: titles.name,
      year: titles.year,
      posterUrl: sql<string | null>`coalesce(${titles.posterUrl}, ${showTitles.posterUrl})`,
      seasonNumber: seasons.number,
      episodeNumber: episodes.number,
      episodeName: episodes.name,
      showName: showTitles.name,
      showId: showTitles.id,
    })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .leftJoin(episodes, eq(episodes.id, playlistItems.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(showTitles, eq(showTitles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, effectiveLibraryId))
    .where(
      and(
        eq(playlistItems.playlistId, args.playlistId),
        eq(libraries.serverId, args.serverId),
        contentFilter(args.viewer, effectiveRatingAges),
        args.after
          ? or(
              gt(playlistItems.position, args.after.position),
              and(eq(playlistItems.position, args.after.position), gt(playlistItems.id, args.after.id))
            )
          : undefined
      )
    )
    .orderBy(asc(playlistItems.position), asc(playlistItems.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items: PlaylistItemView[] = page.map((r) => ({
    id: r.id,
    position: r.position,
    titleId: r.titleId,
    episodeId: r.episodeId,
    titleKind: r.titleKind,
    name: r.titleName ?? r.episodeName,
    year: r.year,
    posterUrl: r.posterUrl,
    seasonNumber: r.seasonNumber,
    episodeNumber: r.episodeNumber,
    showName: r.showName,
    showId: r.showId,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? { position: last.position, id: last.id } : null };
}

/** How many items each of these playlists shows THIS viewer (post-filter), in one grouped query. */
export async function countVisibleItems(
  ex: Executor,
  args: { playlistIds: string[]; serverId: string; viewer: AccessProfile }
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(args.playlistIds.map((id) => [id, 0]));
  if (args.playlistIds.length === 0) return counts;
  const rows = await ex
    .select({ playlistId: playlistItems.playlistId, n: count() })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .leftJoin(episodes, eq(episodes.id, playlistItems.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(showTitles, eq(showTitles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, effectiveLibraryId))
    .where(
      and(
        inArray(playlistItems.playlistId, args.playlistIds),
        eq(libraries.serverId, args.serverId),
        contentFilter(args.viewer, effectiveRatingAges)
      )
    )
    .groupBy(playlistItems.playlistId);
  for (const r of rows) counts.set(r.playlistId, Number(r.n));
  return counts;
}
