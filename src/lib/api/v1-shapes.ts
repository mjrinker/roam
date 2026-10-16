/** The JSON shapes the /api/v1 browse routes answer with, built from what the TV pages already read (so sharing and age limits apply the same way). */
import type { LibraryKind } from "@/lib/db/schema";

export type ItemType = "movie" | "show" | "episode" | "audiobook" | "audio" | "album" | "artist" | "photo" | "clip" | "collection";

/** A thing in a list: enough to draw a card and to open or play it. */
export interface ApiItem {
  type: ItemType;
  id: string;
  name: string;
  /** The small line under the name: the year, an author, an artist... */
  subtitle: string | null;
  posterUrl: string | null;
  /** True for covers that are square (books, music), false for tall posters. */
  square: boolean;
  /** 0 to 1, for "continue" lists. */
  progress?: number;
}

/** Where a TV-relative address ("/title/ID", "/show/ID", "/book/ID", "/listen/ID", "/album/ID", "/artist/ID") leads, as a type and id. */
export function refFromHref(href: string): { type: ItemType; id: string } | null {
  const m = /^\/(title|show|book|listen|album|artist)\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(href);
  if (!m) return null;
  const type: ItemType = m[1] === "title" ? "movie" : m[1] === "show" ? "show" : m[1] === "book" ? "audiobook" : m[1] === "listen" ? "audio" : m[1] === "album" ? "album" : "artist";
  return { type, id: m[2] };
}

/** How to play it: the player endpoint to ask for a manifest (video), or the listening one (audiobooks, audio files, songs). */
export function playPath(type: ItemType, id: string): string | null {
  if (type === "movie" || type === "episode" || type === "clip") return `/api/play/${type === "episode" ? "episode" : "title"}/${id}`;
  if (type === "audiobook" || type === "audio") return `/api/audiobooks/${id}/manifest`;
  return null;
}

export const LIBRARY_STYLES = ["grid", "folders", "artists", "timeline"] as const;

export interface ApiLibrary {
  id: string;
  name: string;
  kind: LibraryKind;
  /** How it is browsed: "grid" (a list of titles), "folders", "artists" (music), "timeline" (photos), or null when nothing here can show it. */
  style: (typeof LIBRARY_STYLES)[number] | null;
}
