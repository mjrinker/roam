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
 * "01 - Intro", "01. Intro", "01 Intro", "1-05 Intro" (disc 1, track 5), "Disc 2 - 05 - Intro". Anything else is all title.
 * A bare "99 Luftballons" reads as track 99; that is inherent to the common "01 Intro" style, and a title tag overrides the name anyway.
 */
export function parseTrackFileName(fileName: string): ParsedTrackFile {
  const dot = fileName.lastIndexOf(".");
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
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
export function placeTrack(args: { folderPath: string; fileName: string; tagArtist?: string | null }): TrackPlacement {
  const parts = args.folderPath.split("/").map((s) => s.trim()).filter(Boolean);
  const file = parseTrackFileName(args.fileName);
  const discFolder = parts.length >= 3 ? parseDiscFolderNumber(parts[2]) : null;
  return {
    artist: parts[0] ?? (args.tagArtist?.trim() || UNKNOWN_ARTIST),
    album: parts[1] ?? SINGLES_ALBUM,
    disc: discFolder ?? file.disc,
    track: file.track,
    title: file.title,
  };
}

/** What artists sort by: lowercase, without a leading "The", so "The Beatles" files under B. */
export function artistSortKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(the|a|an)\s+(?=\S)/, "");
}

/** What two spellings of the same artist or album share: lowercase, one space between words. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");
