/** Playlists on a TV: browsing the ones this profile owns, was given, or that are public on the server, and opening their items. Read-only. */
import { getPlaylistDetail, listPlaylists } from "@/lib/playlists/service";
import { listVisibleItems, type ItemCursor, type PlaylistItemView } from "@/lib/playlists/items";
import type { Executor } from "@/lib/playlists/executor";
import type { TvScope } from "@/lib/tv/data";

export const TV_PLAYLIST_PAGE = 24;

export interface TvPlaylistSummary {
  id: string;
  name: string;
  itemCount: number;
  ownerName: string | null;
}

/** The playlists this profile can see on this server, newest first (one page is plenty for a TV). */
export async function tvPlaylists(ex: Executor, scope: TvScope): Promise<TvPlaylistSummary[]> {
  const result = await listPlaylists(ex, { serverId: scope.actor.serverId, viewerId: scope.viewerId, limit: 50 });
  if (!result.ok) return [];
  return result.value.playlists.map((p) => ({ id: p.id, name: p.name, itemCount: p.itemCount, ownerName: p.owner?.name ?? null }));
}

/** A cursor in a URL: the position and id of the last item shown, or "bad". */
export function parsePlaylistCursor(raw: string | null): ItemCursor | null | "bad" {
  if (!raw) return null;
  const sep = raw.indexOf("~");
  const position = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  return sep > 0 && Number.isSafeInteger(position) && position >= 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? { position, id } : "bad";
}
export const playlistCursorParam = (c: ItemCursor): string => `${c.position}~${c.id}`;

/** One playlist and a page of the items this profile may see in it. Null when it doesn't exist, isn't visible, or belongs to another server. */
export async function tvPlaylist(ex: Executor, scope: TvScope, playlistId: string, after: ItemCursor | null) {
  const detail = await getPlaylistDetail(ex, { playlistId, viewerId: scope.viewerId });
  if (!detail.ok || detail.value.serverId !== scope.actor.serverId) return null;
  const page = await listVisibleItems(ex, { playlistId, lib: scope.actor, viewer: scope.viewer, limit: TV_PLAYLIST_PAGE, after });
  return { playlist: { id: detail.value.id, name: detail.value.name, description: detail.value.description, itemCount: detail.value.itemCount, ownerName: detail.value.owner?.name ?? null }, ...page };
}

/** Where an item opens, relative to the TV's base path: an episode plays, a movie and a show open their pages, a book, audio file or song plays. */
export function playlistItemHref(item: Pick<PlaylistItemView, "episodeId" | "titleId" | "titleKind">): string | null {
  if (item.episodeId) return `/watch/episode/${item.episodeId}`;
  if (!item.titleId) return null;
  if (item.titleKind === "photo" || item.titleKind === "ebook") return null; // nothing to open on a TV
  if (item.titleKind === "show") return `/show/${item.titleId}`;
  if (item.titleKind === "audiobook") return `/listen/${item.titleId}`;
  return `/title/${item.titleId}`;
}

/** The name and small print a card shows for an item. */
export function playlistItemLabel(item: PlaylistItemView): { name: string; meta: string | null } {
  if (item.episodeId) return { name: item.showName ?? item.name ?? "Episode", meta: `S${item.seasonNumber ?? "?"} · E${item.episodeNumber ?? "?"}${item.name ? ` · ${item.name}` : ""}` };
  return { name: item.name ?? "Untitled", meta: item.year ? String(item.year) : null };
}
