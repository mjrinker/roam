/** A TV playing through a playlist ("Play all"): the same queue rules the web uses, with TV addresses. */
import { nextAfter, queueNext, type NextTarget } from "@/lib/playlists/next";
import type { Executor } from "@/lib/playlists/executor";
import type { TvScope } from "@/lib/tv/data";

export interface QueueContext {
  playlistId: string;
  itemId: string;
  /** A show entry replaying because every episode was already watched. */
  replay: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The queue named in a page's address (?playlist=&item=[&replay=1]), or null when it isn't well formed. Whether it is genuine is checked separately. */
export function parseQueueContext(query: URLSearchParams): QueueContext | null {
  const playlistId = query.get("playlist");
  const itemId = query.get("item");
  return playlistId && itemId && UUID.test(playlistId) && UUID.test(itemId) ? { playlistId, itemId, replay: query.get("replay") === "1" } : null;
}

/** Where a queue target plays on the TV, carrying the queue along so the one after it can be found. */
export function targetHref(base: string, target: NextTarget, playlistId: string): string {
  const q = `?playlist=${playlistId}&item=${target.itemId}${target.replay ? "&replay=1" : ""}`;
  if (target.kind === "audiobook") return `${base}/listen/${target.id}${q}`;
  return `${base}/watch/${target.kind === "episode" ? "episode" : "title"}/${target.id}${q}`;
}

export type TvQueueNext = { valid: false } | { valid: true; next: NextTarget | null };

/**
 * For a page opened inside a queue: whether the queue is genuine (the profile can see the playlist, the item is still in it and visible,
 * and what is playing really is that item), and what comes next. `valid: false` means "ignore the queue and behave normally".
 */
export async function tvQueueNext(ex: Executor, scope: TvScope, ctx: QueueContext, current: { titleId?: string; episodeId?: string }): Promise<TvQueueNext> {
  const check = await queueNext(ex, { playlistId: ctx.playlistId, itemId: ctx.itemId, viewerId: scope.viewerId, ...current, replay: ctx.replay });
  if (!check.valid) return { valid: false };
  if (!check.next) return { valid: true, next: null };
  const next = await nextAfter(ex, { playlistId: ctx.playlistId, viewerId: scope.viewerId, afterItemId: ctx.itemId, currentEpisodeId: current.episodeId, replay: ctx.replay });
  return { valid: true, next: next.ok ? next.value : null };
}

/** What "Play all" starts with: the first thing the profile can play in the playlist, or null when there isn't anything. */
export async function tvQueueStart(ex: Executor, scope: TvScope, playlistId: string): Promise<NextTarget | null> {
  const first = await nextAfter(ex, { playlistId, viewerId: scope.viewerId });
  return first.ok ? first.value : null;
}
