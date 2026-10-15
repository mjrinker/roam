/** Changing playlists from a TV: what this profile may do to one, the order of what it can see, and moving an item one step. */
import { getPlaylistDetail } from "@/lib/playlists/service";
import { listVisibleItems, type ItemCursor, type PlaylistItemView } from "@/lib/playlists/items";
import { moveItem } from "@/lib/playlists/item-service";
import type { Executor } from "@/lib/playlists/executor";
import type { TvScope } from "@/lib/tv/data";

/** The most items the arrange page shows (and the most a move looks through). */
export const ARRANGE_MAX = 200;

/** What this profile may do with a playlist, or null when it can't see it (or it is on another server). */
export async function tvPlaylistCaps(ex: Executor, scope: TvScope, playlistId: string) {
  const detail = await getPlaylistDetail(ex, { playlistId, viewerId: scope.viewerId });
  if (!detail.ok || detail.value.serverId !== scope.actor.serverId) return null;
  return { name: detail.value.name, can: detail.value.can };
}

/** The items this profile can see, in order, up to ARRANGE_MAX. */
export async function visibleItems(ex: Executor, scope: TvScope, playlistId: string): Promise<{ items: PlaylistItemView[]; more: boolean }> {
  const page = await listVisibleItems(ex, { playlistId, lib: scope.actor, viewer: scope.viewer, limit: ARRANGE_MAX, after: null as ItemCursor | null });
  return { items: page.items, more: !!page.nextCursor };
}

export type StepResult = { ok: true } | { ok: false; status: number };

/** Moves an item one place up or down among what the profile sees (hidden items stay where they are). */
export async function stepItem(ex: Executor, scope: TvScope, args: { playlistId: string; itemId: string; direction: "up" | "down" }): Promise<StepResult> {
  const { items } = await visibleItems(ex, scope, args.playlistId);
  const ids = items.map((i) => i.id);
  const at = ids.indexOf(args.itemId);
  if (at < 0) return { ok: false, status: 404 };
  if (args.direction === "up" ? at === 0 : at === ids.length - 1) return { ok: true }; // already at the end it is moving towards
  // Up: just after the one two above (or the top). Down: just after the one below it.
  const after = args.direction === "up" ? (at >= 2 ? ids[at - 2] : null) : ids[at + 1];
  const moved = await moveItem(ex, { playlistId: args.playlistId, viewerId: scope.viewerId, itemId: args.itemId, afterItemId: after });
  return moved.ok ? { ok: true } : { ok: false, status: moved.status };
}
