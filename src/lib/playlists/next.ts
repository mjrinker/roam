/**
 * "What plays next" inside a playlist queue, for one viewer. A show entry plays
 * the viewer's next unwatched episode (see next-episode.ts for the rules) and
 * steps through its episodes before moving on; other entries are one stop each.
 * Items the viewer can't see, and show entries with nothing playable, are
 * skipped. The "next item" is a single SQL query — never a loop over skipped rows.
 */
import { and, asc, eq, exists, gt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { contentFilter } from "@/lib/content/access";
import { episodes, libraries, mediaFiles, playlistItems, seasons, titles, watchState } from "@/lib/db/schema";
import { loadContext } from "./context";
import type { Executor } from "./executor";
import { findVisibleItem } from "./items";
import { nextEpisodeAfter, pickStartEpisode, type EpisodeCandidate } from "./next-episode";
import { NOT_FOUND, ok, type Result } from "./results";

const showTitles = alias(titles, "show_titles");
const candEpisodes = alias(episodes, "cand_episodes");
const candSeasons = alias(seasons, "cand_seasons");

export interface NextTarget {
  /** The playlist item this target belongs to. */
  itemId: string;
  kind: "movie" | "episode" | "audiobook";
  id: string;
  href: string;
  /** True when a show entry is replaying because every episode was already finished. */
  replay: boolean;
}

function queueQuery(playlistId: string, itemId: string, replay: boolean) {
  return `?playlist=${playlistId}&item=${itemId}${replay ? "&replay=1" : ""}`;
}

/** The show's episodes that have a media file, with this viewer's progress on each. */
export async function candidateEpisodes(ex: Executor, args: { showId: string; viewerId: string }): Promise<EpisodeCandidate[]> {
  const rows = await ex
    .select({
      id: episodes.id,
      seasonNumber: seasons.number,
      episodeNumber: episodes.number,
      finished: watchState.finished,
      positionSeconds: watchState.positionSeconds,
      updatedAt: watchState.updatedAt,
    })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(
      watchState,
      and(eq(watchState.viewerId, args.viewerId), eq(watchState.ownerKind, "episode"), eq(watchState.ownerId, episodes.id))
    )
    .where(
      and(
        eq(seasons.titleId, args.showId),
        exists(
          ex
            .select({ one: mediaFiles.id })
            .from(mediaFiles)
            .where(and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
        )
      )
    );
  return rows.map((r) => ({
    id: r.id,
    seasonNumber: r.seasonNumber,
    episodeNumber: r.episodeNumber,
    finished: r.finished ?? false,
    progressSeconds: r.positionSeconds ?? 0,
    updatedAt: r.updatedAt ?? null,
  }));
}

/**
 * The target after `afterItemId`. `currentEpisodeId` (with `replay`) is the
 * episode just watched when the finished item is a show entry. Ok(null) means
 * the queue is over; NOT_FOUND means the playlist or item isn't available.
 */
export async function nextAfter(
  ex: Executor,
  args: { playlistId: string; viewerId: string; afterItemId: string; currentEpisodeId?: string; replay?: boolean }
): Promise<Result<NextTarget | null>> {
  const ctx = await loadContext(ex, args);
  if (!ctx) return NOT_FOUND;
  const { playlist, access } = ctx;
  const serverId = playlist.serverId;
  const base = `/s/${serverId}`;
  const replayIn = args.replay === true;

  const after = await findVisibleItem(ex, { playlistId: playlist.id, itemId: args.afterItemId, serverId, viewer: access });
  if (!after) return NOT_FOUND;

  const episodeTarget = (itemId: string, episodeId: string, replay: boolean): NextTarget => ({
    itemId,
    kind: "episode",
    id: episodeId,
    href: `${base}/watch/episode/${episodeId}${queueQuery(playlist.id, itemId, replay)}`,
    replay,
  });

  // 1) Still inside a show entry? Step to its next episode.
  const [afterRow] = await ex
    .select({ titleId: playlistItems.titleId, titleKind: titles.kind })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .where(eq(playlistItems.id, after.id));
  if (afterRow?.titleKind === "show" && afterRow.titleId && args.currentEpisodeId) {
    const candidates = await candidateEpisodes(ex, { showId: afterRow.titleId, viewerId: ctx.viewer.id });
    const nextEpisodeId = nextEpisodeAfter(candidates, args.currentEpisodeId, replayIn);
    if (nextEpisodeId) return ok(episodeTarget(after.id, nextEpisodeId, replayIn));
  }

  // 2) The next playable item the viewer can see, in one query.
  const hasCandidates = exists(
    ex
      .select({ one: candEpisodes.id })
      .from(candEpisodes)
      .innerJoin(candSeasons, eq(candSeasons.id, candEpisodes.seasonId))
      .where(
        and(
          eq(candSeasons.titleId, titles.id),
          exists(
            ex
              .select({ one: mediaFiles.id })
              .from(mediaFiles)
              .where(and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, candEpisodes.id)))
          )
        )
      )
  );
  const [next] = await ex
    .select({
      id: playlistItems.id,
      titleId: playlistItems.titleId,
      episodeId: playlistItems.episodeId,
      titleKind: titles.kind,
    })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .leftJoin(episodes, eq(episodes.id, playlistItems.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(showTitles, eq(showTitles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, sql`coalesce(${titles.libraryId}, ${showTitles.libraryId})`))
    .where(
      and(
        eq(playlistItems.playlistId, playlist.id),
        eq(libraries.serverId, serverId),
        contentFilter(access, sql`coalesce(${titles.ratingAges}, ${showTitles.ratingAges})`),
        or(
          gt(playlistItems.position, after.position),
          and(eq(playlistItems.position, after.position), gt(playlistItems.id, after.id))
        ),
        // A show entry with nothing playable is skipped; everything else is one stop.
        or(sql`${playlistItems.episodeId} IS NOT NULL`, ne(titles.kind, "show"), hasCandidates)
      )
    )
    .orderBy(asc(playlistItems.position), asc(playlistItems.id))
    .limit(1);
  if (!next) return ok(null);

  if (next.episodeId) return ok(episodeTarget(next.id, next.episodeId, false));
  if (next.titleKind === "audiobook" && next.titleId) {
    return ok({
      itemId: next.id,
      kind: "audiobook",
      id: next.titleId,
      href: `${base}/book/${next.titleId}${queueQuery(playlist.id, next.id, false)}`,
      replay: false,
    });
  }
  if (next.titleKind === "show" && next.titleId) {
    const pick = pickStartEpisode(await candidateEpisodes(ex, { showId: next.titleId, viewerId: ctx.viewer.id }));
    return pick ? ok(episodeTarget(next.id, pick.episodeId, pick.replay)) : ok(null);
  }
  if (next.titleId) {
    return ok({
      itemId: next.id,
      kind: "movie",
      id: next.titleId,
      href: `${base}/watch/title/${next.titleId}${queueQuery(playlist.id, next.id, false)}`,
      replay: false,
    });
  }
  return ok(null);
}
