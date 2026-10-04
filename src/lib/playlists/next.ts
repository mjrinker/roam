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
import { libraryVisible } from "@/lib/content/library-access";
import { episodes, libraries, mediaFiles, playlistItems, seasons, titles, watchState } from "@/lib/db/schema";
import { loadContext } from "./context";
import type { Executor } from "./executor";
import { findVisibleItem, hasCandidateEpisodes } from "./items";
import { nextEpisodeAfter, pickStartEpisode, type EpisodeCandidate } from "./next-episode";
import { NOT_FOUND, ok, type Result } from "./results";

const showTitles = alias(titles, "show_titles");

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
 * The target after `afterItemId` — or the FIRST playable item when it is omitted
 * ("Play all"). `currentEpisodeId` (with `replay`) is the episode just watched
 * when the finished item is a show entry. Ok(null) means the queue is over (or
 * empty); NOT_FOUND means the playlist or item isn't available.
 */
export async function nextAfter(
  ex: Executor,
  args: { playlistId: string; viewerId: string; afterItemId?: string; currentEpisodeId?: string; replay?: boolean }
): Promise<Result<NextTarget | null>> {
  const ctx = await loadContext(ex, args);
  if (!ctx) return NOT_FOUND;
  const { playlist, access } = ctx;
  const serverId = playlist.serverId;
  const base = `/s/${serverId}`;
  const replayIn = args.replay === true;

  const after = args.afterItemId
    ? await findVisibleItem(ex, { playlistId: playlist.id, itemId: args.afterItemId, lib: ctx.lib, viewer: access })
    : null;
  if (args.afterItemId && !after) return NOT_FOUND;

  const episodeTarget = (itemId: string, episodeId: string, replay: boolean): NextTarget => ({
    itemId,
    kind: "episode",
    id: episodeId,
    href: `${base}/watch/episode/${episodeId}${queueQuery(playlist.id, itemId, replay)}`,
    replay,
  });

  // 1) Still inside a show entry? Step to its next episode.
  const [afterRow] = after
    ? await ex
        .select({ titleId: playlistItems.titleId, titleKind: titles.kind })
        .from(playlistItems)
        .leftJoin(titles, eq(titles.id, playlistItems.titleId))
        .where(eq(playlistItems.id, after.id))
    : [];
  if (after && afterRow?.titleKind === "show" && afterRow.titleId && args.currentEpisodeId) {
    const candidates = await candidateEpisodes(ex, { showId: afterRow.titleId, viewerId: ctx.viewer.id });
    const nextEpisodeId = nextEpisodeAfter(candidates, args.currentEpisodeId, replayIn);
    if (nextEpisodeId) return ok(episodeTarget(after.id, nextEpisodeId, replayIn));
  }

  // 2) The next playable item the viewer can see, in one query.
  const hasCandidates = hasCandidateEpisodes(ex, titles.id);
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
        libraryVisible(ex, ctx.lib),
        contentFilter(access, sql`coalesce(${titles.ratingAges}, ${showTitles.ratingAges})`),
        after
          ? or(
              gt(playlistItems.position, after.position),
              and(eq(playlistItems.position, after.position), gt(playlistItems.id, after.id))
            )
          : undefined,
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

export type QueueNext =
  | { valid: false }
  | { valid: true; next: { href: string; label: string } | null };

/**
 * For a watch/book page opened with `?playlist=&item=` (&replay=1): checks the
 * queue context is genuine — the viewer can view the playlist, the item is still
 * in it and visible to them, and the thing being played IS that item (or an
 * episode of the show it names) — and, if so, what comes next. `valid: false`
 * means "ignore the parameters and behave normally"; `valid: true, next: null`
 * means the queue is over, so no next link at all.
 */
export async function queueNext(
  ex: Executor,
  args: { playlistId: string; itemId: string; viewerId: string; titleId?: string; episodeId?: string; replay?: boolean }
): Promise<QueueNext> {
  const ctx = await loadContext(ex, { playlistId: args.playlistId, viewerId: args.viewerId });
  if (!ctx) return { valid: false };
  const visible = await findVisibleItem(ex, {
    playlistId: ctx.playlist.id,
    itemId: args.itemId,
    lib: ctx.lib,
    viewer: ctx.access,
  });
  if (!visible) return { valid: false };

  const [item] = await ex
    .select({ titleId: playlistItems.titleId, episodeId: playlistItems.episodeId, titleKind: titles.kind })
    .from(playlistItems)
    .leftJoin(titles, eq(titles.id, playlistItems.titleId))
    .where(eq(playlistItems.id, args.itemId));
  if (!item) return { valid: false };

  let matches = false;
  if (item.episodeId) {
    matches = args.episodeId === item.episodeId;
  } else if (item.titleId && item.titleKind === "show") {
    if (args.episodeId) {
      const [ep] = await ex
        .select({ id: episodes.id })
        .from(episodes)
        .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
        .where(and(eq(episodes.id, args.episodeId), eq(seasons.titleId, item.titleId)));
      matches = Boolean(ep);
    }
  } else if (item.titleId) {
    matches = args.titleId === item.titleId;
  }
  if (!matches) return { valid: false };

  const next = await nextAfter(ex, {
    playlistId: ctx.playlist.id,
    viewerId: args.viewerId,
    afterItemId: args.itemId,
    currentEpisodeId: item.titleKind === "show" ? args.episodeId : undefined,
    replay: args.replay,
  });
  if (!next.ok || !next.value) return { valid: true, next: null };
  return { valid: true, next: { href: next.value.href, label: "Next in playlist" } };
}
