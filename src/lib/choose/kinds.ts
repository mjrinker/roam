import type { LibraryKind } from "@/lib/db/schema";

/** The library kinds a choice can be made from (pictures have nothing to watch, listen to or read). Kept apart from the database code so pages can use it freely. */
export const CHOOSABLE_KINDS: readonly LibraryKind[] = ["movies", "shows", "video", "audiobooks", "audio", "music", "ebooks"];
export const isChoosableKind = (kind: LibraryKind): boolean => CHOOSABLE_KINDS.includes(kind);
