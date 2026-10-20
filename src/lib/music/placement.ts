/**
 * Where a track belongs in a music library laid out Artist / Album / track. The folders decide the grouping
 * (that is how the owner organised their files, and it makes the result predictable); the file's own tags
 * only fill in what the folders can't say. Pure, so client components can use it too.
 */
import { parseDiscFolderNumber } from "@/lib/scan/conventions";

export const UNKNOWN_ARTIST = "Unknown Artist";
/** The album of a track that sits straight in an artist's folder (or in the library's root). */
export const SINGLES_ALBUM = "Singles";

export interface ParsedTrackFile {
  /** The number in front of the name ("01 - Intro" -> 1), if any. */
  track: number | null;
  /** A disc written in front of the track ("2-05 Intro" -> 2), if any. */
  disc: number | null;
  /** The name with that number and its separator removed. */
  title: string;
}

/**
 * "01 - Intro", "01. Intro", "01 Intro", "1-05 Intro" (disc 1, track 5), "Disc 2 - 05 - Intro", and Plex's "302 - Intro" (disc 3, track 2).
 * Anything else is all title. The Plex form is only read when the whole album is numbered that way (`plexDiscs`, see usesPlexDiscNumbers):
 * on its own "105 - Big Number" is a compilation's track 105.
 * A bare "99 Luftballons" reads as track 99; that is inherent to the common "01 Intro" style, and a title tag overrides the name anyway.
 */
export function parseTrackFileName(fileName: string, opts: { plexDiscs?: boolean } = {}): ParsedTrackFile {
  const dot = fileName.lastIndexOf(".");
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  // Plex's multi-disc names put the disc in front of the track number: "302 - Name" is track 2 of disc 3.
  const plexDisc = opts.plexDiscs ? /^([1-9])(\d{2})\s*[-._)]\s*(.+)$/.exec(base) : null;
  if (plexDisc && Number(plexDisc[2]) >= 1 && /[\p{L}\p{N}]/u.test(plexDisc[3])) return { disc: Number(plexDisc[1]), track: Number(plexDisc[2]), title: plexDisc[3].trim() };
  const discTrack = /^(?:disc|cd)\s*(\d{1,2})\s*[-._]\s*(\d{1,3})\s*[-._)]?\s+(.+)$/i.exec(base) ?? /^(\d{1,2})-(\d{2,3})\s*[-._)]?\s+(.+)$/.exec(base);
  if (discTrack) return { disc: Number(discTrack[1]), track: Number(discTrack[2]), title: discTrack[3].trim() };
  const plain = /^(\d{1,3})\s*[-._)]\s*(.+)$/.exec(base) ?? /^(\d{1,3})\s+(\D.*)$/.exec(base);
  if (plain && /[\p{L}\p{N}]/u.test(plain[2])) return { disc: null, track: Number(plain[1]), title: plain[2].trim() };
  return { disc: null, track: null, title: base };
}

export interface TrackPlacement {
  artist: string;
  album: string;
  disc: number | null;
  track: number | null;
  /** The name to show when the file's tags give none. */
  title: string;
}

/**
 * `folderPath` is library-relative ("Artist/Album/CD2"; '' = the library root). Artist and album are its first
 * two folders; a third that is a disc folder (CD1, Disc 2) sets the disc. A file straight in an artist folder is
 * a single; one in the root is credited to the artist in its tags, else to nobody known.
 */
export function placeTrack(args: { folderPath: string; fileName: string; tagArtist?: string | null; plexDiscs?: boolean }): TrackPlacement {
  const parts = args.folderPath.split("/").map((s) => s.trim()).filter(Boolean);
  const file = parseTrackFileName(args.fileName, { plexDiscs: args.plexDiscs });
  const discFolder = parts.length >= 3 ? parseDiscFolderNumber(parts[2]) : null;
  return {
    artist: parts[0] ?? (args.tagArtist?.trim() || UNKNOWN_ARTIST),
    album: parts[1] ?? SINGLES_ALBUM,
    disc: discFolder ?? file.disc,
    track: file.track,
    title: file.title,
  };
}

/**
 * Whether the files of one album folder are numbered the way Plex's multi-disc albums are: disc number in front of the track number, so track 2 of
 * disc 3 is "302 - Name" (the Pink Floyd "The Wall" example: 101, 102, 201, 202). Every numbered file must be a three-digit number from 101 up with
 * a track part of 01 or more, and there must be at least two: one such name alone is just a big track number.
 */
export function usesPlexDiscNumbers(fileNames: string[]): boolean {
  const numbered = fileNames.map((n) => parseTrackFileName(n)).filter((p) => p.track !== null);
  return numbered.length >= 2 && numbered.every((p) => p.track! >= 101 && p.track! <= 999 && p.track! % 100 >= 1);
}

/** What artists sort by: lowercase, without a leading "The", so "The Beatles" files under B. */
export function artistSortKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(the|a|an)\s+(?=\S)/, "");
}

/** What two spellings of the same artist or album share: lowercase, one space between words. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");
