/**
 * Which libraries are which. Two disjoint families, decided by explicit lists so a library kind added
 * later is in NEITHER until someone says which (a deny-list would let it through everywhere):
 *
 * - External-metadata libraries (movies, shows, audiobooks): matched against TMDB / OMDb / Audible,
 *   scanned folder-per-title, and their titles' `box_folder_id` is a real Box folder.
 * - File-tree libraries (video, audio, photos, music, ebooks): every file is its own title, named and described by the file
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

export const FILE_TREE_KINDS = ["video", "audio", "photos", "music", "ebooks"] as const satisfies readonly LibraryKind[];
export type FileTreeKind = (typeof FILE_TREE_KINDS)[number];

/**
 * Libraries whose items appear in global search and the home page's "recently added" rows. A positive
 * list, so a kind added later stays out of them until someone decides: music (one title per song) waits for an
 * album-level view, and photo libraries are reached
 * through their own timeline, and would otherwise flood both with thousands of pictures.
 */
export const GLOBALLY_LISTED_LIBRARY_KINDS: readonly LibraryKind[] = ["movies", "shows", "audiobooks", "video", "audio", "ebooks"];

export const EXTERNAL_METADATA_KINDS = ["movies", "shows", "audiobooks"] as const satisfies readonly LibraryKind[];

/** Libraries of pictures (and the videos beside them): browsed as a timeline and albums rather than folder by folder. */
export const PHOTO_LIBRARY_KINDS = ["photos"] as const satisfies readonly LibraryKind[];

/**
 * Whether playing something in this library records a resume position. Clips in a photo library and songs in a
 * music library always start from the beginning, so nothing is stored (and nothing shows up under "continue").
 */
export function libraryRemembersProgress(kind: LibraryKind | null | undefined): boolean {
  return kind !== "photos" && kind !== "music" && kind !== "ebooks";
}

/**
 * Whether things in this library can be marked watched, listened to or read. Pictures (and clips beside them) have nothing to mark.
 * Songs and eBooks keep no resume place, but can still carry the finished flag: a song is "listened to" (marked an album at a time),
 * an eBook "read".
 */
export function libraryHasDoneState(kind: LibraryKind | null | undefined): boolean {
  return kind !== "photos";
}

/** Libraries of songs, browsed as artists, albums and songs. */
export function isMusicLibraryKind(kind: LibraryKind | null | undefined): boolean {
  return kind === "music";
}

export function isPhotoLibraryKind(kind: LibraryKind | null | undefined): boolean {
  return kind === "photos";
}

export function isFileTreeLibraryKind(kind: LibraryKind | null | undefined): kind is FileTreeKind {
  return kind === "video" || kind === "audio" || kind === "photos" || kind === "music" || kind === "ebooks";
}

/** True only for the kinds that are matched against an outside service and whose titles live in a real Box folder. */
export function libraryKindUsesExternalMetadata(kind: LibraryKind | null | undefined): boolean {
  return kind === "movies" || kind === "shows" || kind === "audiobooks";
}

/**
 * How a library is laid out on the TV interface. A kind that isn't listed isn't on TV yet (it is counted on the home screen, not shown).
 * `grid`: one wall of titles; `folders`: a file manager; `artists`: artists, then albums, then songs; `timeline`: pictures by date.
 */
export type TvBrowseStyle = "grid" | "folders" | "artists" | "timeline";
const TV_BROWSE: Partial<Record<LibraryKind, TvBrowseStyle>> = {
  movies: "grid",
  shows: "grid",
  audiobooks: "grid",
  video: "folders",
  audio: "folders",
  music: "artists",
  photos: "timeline",
};
export const tvBrowseStyle = (kind: LibraryKind | null | undefined): TvBrowseStyle | null => (kind ? (TV_BROWSE[kind] ?? null) : null);

/** The libraries whose items the TV plays as video, and as audio (what "continue watching" and "continue listening" read from). */
export const TV_WATCH_KINDS: readonly LibraryKind[] = ["movies", "video"];
export const TV_LISTEN_KINDS: readonly LibraryKind[] = ["audiobooks", "audio", "music"];

/** The name a library kind goes by on the TV's home screen. */
export const TV_KIND_LABEL: Partial<Record<LibraryKind, string>> = {
  movies: "Movies",
  shows: "TV Shows",
  audiobooks: "Audiobooks",
  video: "Videos",
  audio: "Audio",
  music: "Music",
  photos: "Photos",
};
