import type { PlaylistItemView } from "@/lib/playlists/items";
import { playlistItemLabel } from "@/lib/tv/playlists";
import type { ApiItem } from "@/lib/api/v1-shapes";

export interface ApiPlaylistItem extends ApiItem {
  /** The entry's own id in the playlist (distinct from the movie's or episode's id). */
  entryId: string;
  /** False for a show with nothing to play yet. */
  playable: boolean;
}

/** A playlist entry as the API shows it, or null for what apps can't open (photos, eBooks, entries with nothing behind them). */
export function playlistApiItem(item: PlaylistItemView): ApiPlaylistItem | null {
  const label = playlistItemLabel(item);
  const base = { entryId: item.id, name: label.name, subtitle: label.meta, posterUrl: item.posterUrl, playable: item.playable };
  if (item.episodeId) return { ...base, type: "episode", id: item.episodeId, square: false };
  if (!item.titleId || item.titleKind === "photo" || item.titleKind === "ebook" || !item.titleKind) return null;
  return { ...base, type: item.titleKind, id: item.titleId, square: item.titleKind === "audiobook" };
}
