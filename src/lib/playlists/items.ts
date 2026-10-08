/**
 * The ONLY place playlist items are read. Every query joins an item to its
 * library and keeps the viewing profile's age restrictions (`contentFilter`)
 * IN SQL, so items a profile may not watch are simply absent: pages, cursors
 * and counts never reveal them. Episode items are rated by their show.
 */
import { and, asc, count, eq, exists, gt, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { PLAYABLE_TITLE_KINDS } from "@/lib/libraries/profile";
import { alias } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { episodes, libraries, mediaFiles, playlistItems, seasons, titles } from "@/lib/db/schema";
import type { Executor } from "./executor";
import { POSITION_GAP } from "./position";

const showTitles = alias(titles, "show_titles");
const candEpisodes = alias(episodes, "cand_episodes");
const candSeasons = alias(seasons, "cand_seasons");

/**
 * SQL: does the show whose id is `showIdColumn` have at least one episode with a
 * media file (i.e. something playable)? A show entry with none is shown disabled
 * and skipped by "Play all". The show's own age rating is applied by the caller's
 * item filter, since episodes inherit it.
 */
export function hasCandidateEpisodes(ex: Executor, showIdColumn: SQLWrapper): SQL {
  return exists(
    ex
      .select({ one: candEpisodes.id })
      .from(candEpisodes)
      .innerJoin(candSeasons, eq(candSeasons.id, candEpisodes.seasonId))
      .where(
        and(
          eq(candSeasons.titleId, sql`${showIdColumn}`),
          exists(
            ex
              .select({ one: mediaFiles.id })
              .from(mediaFiles)
              .where(and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, candEpisodes.id)))
          )
        )
      )
  );
}

// An item's title is the title itself, or the show an episode belongs to.
const effectiveLibraryId = sql`coalesce(${titles.libraryId}, ${showTitles.libraryId})`;
/** A playlist only ever holds playable titles: a photo (or a kind added later) is never offered, listed, queued or copied. Episodes have no title of their own, hence the null. */
const playableTitle = or(isNull(titles.kind), inArray(titles.kind, [...PLAYABLE_TITLE_KINDS]))!;
const effectiveRatingAges = sql`coalesce(${titles.ratingAges}, ${showTitles.ratingAges})`;

export interface PlaylistItemView {
  id: string;
  position: number;
  titleId: string | null;
  episodeId: string | null;
  /** The title's kind (movie|show|audiobook), or null for an episode item. */
  titleKind: "movie" | "show" | "audiobook" | "photo" | "ebook" | null;
  name: string | null;
  year: number | null;
  posterUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  showName: string | null;
  showId: string | null;
  /** False for a show entry with nothing playable (shown disabled, skipped by Play all). */
  playable: boolean;
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
  args: { playlistId: string; lib: LibraryActor; viewer: AccessProfile; limit?: number; after?: ItemCursor | null }
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
      playable: sql<boolean>`(${playlistItems.episodeId} IS NOT NULL OR ${titles.kind} <> 'show' OR ${hasCandidateEpisodes(ex, titles.id)})`,
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
        libraryVisible(ex, args.lib),
        playableTitle,
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
    playable: Boolean(r.playable),
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? { position: last.position, id: last.id } : null };
}

/** How many items each of these playlists shows THIS viewer (post-filter), in one grouped query. */
export async function countVisibleItems(
  ex: Executor,
  args: { playlistIds: string[]; lib: LibraryActor; viewer: AccessProfile }
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
        libraryVisible(ex, args.lib),
        playableTitle,
        contentFilter(args.viewer, effectiveRatingAges)
      )
    )
    .groupBy(playlistItems.playlistId);
  for (const r of rows) counts.set(r.playlistId, Number(r.n));
  return counts;
}

export type AddableTarget = { titleId: string } | { episodeId: string };

/**
 * Resolves what a viewer is trying to add: the title or episode must exist in a
 * library of THIS server and pass the viewer's age restrictions (episodes are
 * rated by their show). Null for anything else — callers answer 404.
 */
export async function findAddableTarget(
  ex: Executor,
  args: { lib: LibraryActor; viewer: AccessProfile; titleId?: string; episodeId?: string }
): Promise<AddableTarget | null> {
  if (args.titleId) {
    const [row] = await ex
      .select({ id: titles.id })
      .from(titles)
      .innerJoin(libraries, eq(libraries.id, titles.libraryId))
      .where(and(eq(titles.id, args.titleId), inArray(titles.kind, [...PLAYABLE_TITLE_KINDS]), libraryVisible(ex, args.lib), contentFilter(args.viewer, titles.ratingAges)));
    return row ? { titleId: row.id } : null;
  }
  if (args.episodeId) {
    const [row] = await ex
      .select({ id: episodes.id })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .innerJoin(showTitles, eq(showTitles.id, seasons.titleId))
      .innerJoin(libraries, eq(libraries.id, showTitles.libraryId))
      .where(
        and(eq(episodes.id, args.episodeId), libraryVisible(ex, args.lib), contentFilter(args.viewer, showTitles.ratingAges))
      );
    return row ? { episodeId: row.id } : null;
  }
  return null;
}

/** An item the viewer may see (in this playlist, on this server, passing their restrictions), or null. */
export async function findVisibleItem(
  ex: Executor,
  args: { playlistId: string; itemId: string; lib: LibraryActor; viewer: AccessProfile }
): Promise<{ id: string; position: number } | null> {
  const [row] = await ex
    .select({ id: playlistItems.id, position: playlistItems.position })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .leftJoin(episodes, eq(episodes.id, playlistItems.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(showTitles, eq(showTitles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, effectiveLibraryId))
    .where(
      and(
        eq(playlistItems.id, args.itemId),
        eq(playlistItems.playlistId, args.playlistId),
        libraryVisible(ex, args.lib),
        playableTitle,
        contentFilter(args.viewer, effectiveRatingAges)
      )
    );
  return row ?? null;
}

/**
 * Copies, in ONE statement, the items of `sourcePlaylistId` that THIS viewer may
 * see into `targetPlaylistId`, renumbering positions 1024, 2048, ... in source
 * order (the window function runs after the restriction filter, so there are no
 * gaps). Returns the number of items copied.
 */
export async function copyVisibleItems(
  ex: Executor,
  args: { sourcePlaylistId: string; targetPlaylistId: string; lib: LibraryActor; viewer: AccessProfile; copierViewerId: string }
): Promise<number> {
  const rows = await ex
    .insert(playlistItems)
    .select(
      ex
        .select({
          id: sql<string>`gen_random_uuid()`.as("id"),
          playlistId: sql<string>`${args.targetPlaylistId}::uuid`.as("playlist_id"),
          titleId: playlistItems.titleId,
          episodeId: playlistItems.episodeId,
          position: sql<number>`(row_number() over (order by ${playlistItems.position}, ${playlistItems.id})) * ${POSITION_GAP}`.as(
            "position"
          ),
          addedByViewerId: sql<string>`${args.copierViewerId}::uuid`.as("added_by_viewer_id"),
          addedAt: sql<Date>`now()`.as("added_at"),
        })
        .from(playlistItems)
        .leftJoin(titles, eq(titles.id, playlistItems.titleId))
        .leftJoin(episodes, eq(episodes.id, playlistItems.episodeId))
        .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
        .leftJoin(showTitles, eq(showTitles.id, seasons.titleId))
        .innerJoin(libraries, eq(libraries.id, effectiveLibraryId))
        .where(
          and(
            eq(playlistItems.playlistId, args.sourcePlaylistId),
            libraryVisible(ex, args.lib),
            playableTitle,
            contentFilter(args.viewer, effectiveRatingAges)
          )
        )
    )
    .returning({ id: playlistItems.id });
  return rows.length;
}
