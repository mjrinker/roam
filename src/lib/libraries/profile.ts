/**
 * Which libraries are which. Two disjoint families, decided by explicit lists so a library kind added
 * later is in NEITHER until someone says which (a deny-list would let it through everywhere):
 *
 * - External-metadata libraries (movies, shows, audiobooks): matched against TMDB / OMDb / Audible,
 *   scanned folder-per-title, and their titles' `box_folder_id` is a real Box folder.
 * - File-tree libraries (video, audio, photos): every file is its own title, named and described by the file
 *   itself, never sent to an outside service; `box_folder_id` is a `file:<id>` key. They are browsed
 *   folder by folder, rated as a whole, and cleaned up when files leave Box.
 *
 * Pure (no database imports) so client components can use it too.
 */
import type { LibraryKind, TitleKind } from "@/lib/db/schema";

/**
 * The title kinds that can be played, tracked and put in a playlist. A positive list: a photo is not one
 * of them (nothing to play), and a kind added later is refused everywhere until someone lists it here.
 */
export const PLAYABLE_TITLE_KINDS: readonly TitleKind[] = ["movie", "show", "audiobook"];

export const FILE_TREE_KINDS = ["video", "audio", "photos"] as const satisfies readonly LibraryKind[];
export type FileTreeKind = (typeof FILE_TREE_KINDS)[number];

/**
 * Libraries whose items appear in global search and the home page's "recently added" rows. A positive
 * list, so a kind added later stays out of them until someone decides: photo libraries are reached
 * through their own timeline, and would otherwise flood both with thousands of pictures.
 */
export const GLOBALLY_LISTED_LIBRARY_KINDS: readonly LibraryKind[] = ["movies", "shows", "audiobooks", "video", "audio"];

export const EXTERNAL_METADATA_KINDS = ["movies", "shows", "audiobooks"] as const satisfies readonly LibraryKind[];

export function isFileTreeLibraryKind(kind: LibraryKind | null | undefined): kind is FileTreeKind {
  return kind === "video" || kind === "audio" || kind === "photos";
}

/** True only for the kinds that are matched against an outside service and whose titles live in a real Box folder. */
export function libraryKindUsesExternalMetadata(kind: LibraryKind | null | undefined): boolean {
  return kind === "movies" || kind === "shows" || kind === "audiobooks";
}
