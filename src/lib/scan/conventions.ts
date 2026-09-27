/**
 * Parses the folder/file naming conventions the scanner expects in Box.
 * These deliberately mirror Plex's own naming conventions (see
 * support.plex.tv's "Naming and Organizing Your Movie/TV Show Files" and
 * "Local Files for Trailers and Extras" articles) so a library someone
 * already built out for Plex can be dropped into Box and scanned as-is:
 *
 *   Movies:  Movie Title (2001)/Movie Title (2001).mp4
 *            Movie Title (2001)/Movie Title (2001) {tmdb-123}.mp4
 *            Movie Title (2001)/Movie Title (2001) - pt1.mp4, - pt2.mp4, ...
 *            Movie Title (2001)/Some Trailer-trailer.mp4  (excluded, not a segment)
 *   Shows:   Show Name (2010) {tmdb-456}/Season 01/Show Name - s01e01 - Title.mp4
 *            .../Show Name - s01e01 - pt1.mp4, - pt2.mp4 (multi-part episode)
 *
 * Known gaps vs. real Plex support (documented rather than silently wrong):
 * - Roam requires pre-converted H.264/AAC video (.mp4/.m4v/.mov) — unlike
 *   Plex, there's no server-side transcoding, so .mkv/.avi/etc. aren't
 *   scanned even though Plex itself would accept them.
 * - {imdb-...} / {tvdb-...} id tags are recognized and stripped from the
 *   parsed title (so they don't corrupt the name/year match) but aren't
 *   resolved to metadata — Roam only integrates with TMDB. {tmdb-...} tags
 *   ARE wired to an exact lookup (see scanner.ts).
 * - Multiple editions in ONE folder (Plex's file-level {edition-...} tag)
 *   are recognized well enough not to corrupt playback — only one edition's
 *   files are used as the movie's segments, the rest are skipped — but
 *   there's no version-switcher UI. Plex's directory-level convention (one
 *   folder per edition) needs no special handling at all: each folder is
 *   already its own title here.
 * - A multi-episode file ("S01E05-E06") is recognized (won't be mis-parsed
 *   as having a garbage title) but is only attached to the first episode
 *   number — Roam's data model doesn't have a way to attach one file to
 *   two episode rows.
 */

import { compareNames } from "./cursor";

const TITLE_YEAR_RE = /^(.*?)\s*\((\d{4})\)\s*$/;
const SEASON_FOLDER_RE = /season\s*0*(\d+)/i;
const EPISODE_FILE_RE = /s0*(\d+)e0*(\d+)(?:\s*-\s*(.+?))?(?:\.[^.]+)?$/i;

// Plex's split-file suffixes for a movie/episode spread across multiple
// files: "MovieName (2001) - pt1.mp4", "- cd2.mp4", "- disc1.mp4", or a
// bare "part1.mp4" with no name prefix at all. Requires a separator (or
// start-of-string) right before the keyword so this can't accidentally
// fire inside an ordinary word (e.g. "The Apartment (1960)" doesn't
// contain "part" as its own token).
const SPLIT_RE = /(?:^|[-_\s])(?:cd|disc|disk|dvd|part|pt)\s*0*(\d+)(?=[-_\s.]|$)/i;
// A parsed "episode title" that's actually just a split-file marker (see
// above) or a second episode number from a multi-episode filename
// ("s01e05-e06", "s01e05-06") — either way, it isn't a real title.
const SUPPRESSED_TITLE_RE = /^(?:(?:cd|disc|disk|dvd|part|pt)\s*0*\d+|e?0*\d+)$/i;

// {tmdb-123}, {imdb-tt0167260}, {tvdb-81547} — Plex's database-id tags.
// Accepts both the documented hyphen form and a bare-space form some tools
// emit. Global so every tag in a folder name gets stripped, even if more
// than one is present.
const ID_TAG_RE = /\{\s*(tmdb|imdb|tvdb)[-\s]+([a-z0-9]+)\s*\}/gi;
// {edition-Extended Cut} — Plex's multiple-editions tag.
const EDITION_TAG_RE = /\{\s*edition-([^}]+?)\s*\}/i;

export interface ParsedTitleFolder {
  name: string;
  year: number | null;
  /** From a {tmdb-123} tag, if present — lets the scanner skip fuzzy search entirely. */
  tmdbId: number | null;
  /** From a directory-level {edition-...} tag, if present. */
  edition: string | null;
}

/**
 * Parses a movie/show folder name like "The Matrix (1999)" -> { name, year },
 * also stripping and extracting any {tmdb-...}/{imdb-...}/{tvdb-...} and
 * {edition-...} tags Plex recognizes in the same position.
 */
export function parseTitleFolderName(folderName: string): ParsedTitleFolder {
  let working = folderName.trim();

  let tmdbId: number | null = null;
  working = working.replace(ID_TAG_RE, (_m, tag: string, id: string) => {
    if (tag.toLowerCase() === "tmdb") tmdbId = Number(id);
    return " ";
  });

  let edition: string | null = null;
  working = working.replace(EDITION_TAG_RE, (_m, ed: string) => {
    edition = ed.trim();
    return " ";
  });

  working = working.replace(/\s{2,}/g, " ").trim();

  const match = TITLE_YEAR_RE.exec(working);
  if (match) {
    return { name: match[1].trim(), year: Number(match[2]), tmdbId, edition };
  }
  return { name: working, year: null, tmdbId, edition };
}

/** Parses "Season 01", "Season 1" -> 1. Returns null if it doesn't match. */
export function parseSeasonFolderName(folderName: string): number | null {
  const match = SEASON_FOLDER_RE.exec(folderName.trim());
  return match ? Number(match[1]) : null;
}

/** A file-level {edition-...} tag, e.g. "MovieName.1080p {edition-Blu-ray Release}.mp4". */
export function parseEditionTag(fileName: string): string | null {
  const match = EDITION_TAG_RE.exec(fileName);
  return match ? match[1].trim() : null;
}

export interface ParsedEpisodeFile {
  season: number;
  episode: number;
  name: string | null;
}

/** Parses "S01E01 - Pilot.mp4" -> { season: 1, episode: 1, name: "Pilot" }. */
export function parseEpisodeFileName(fileName: string): ParsedEpisodeFile | null {
  const match = EPISODE_FILE_RE.exec(fileName.trim());
  if (!match) return null;
  let name = match[3]?.trim() || null;
  if (name && SUPPRESSED_TITLE_RE.test(name)) name = null;
  return {
    season: Number(match[1]),
    episode: Number(match[2]),
    name,
  };
}

/**
 * Given the files directly inside a movie or episode folder, returns them
 * ordered into playback segments. A file matching Plex's split-file suffix
 * (partN/ptN/cdN/discN/diskN/dvdN) is ordered by N; anything else falls
 * back to alphabetical order. A single video file simply becomes part
 * index 0.
 */
export function orderMediaSegments<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const aPart = SPLIT_RE.exec(a.name)?.[1];
    const bPart = SPLIT_RE.exec(b.name)?.[1];
    if (aPart && bPart) return Number(aPart) - Number(bPart);
    if (aPart) return -1;
    if (bPart) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Groups a season folder's video files by episode number, so multi-part
 * episodes (S01E01 - part1.mp4 / part2.mp4) collapse into one episode with
 * ordered segments instead of one row overwriting another. Files that
 * don't match the SxxExx convention are dropped (same as the scanner
 * silently skipping them file-by-file previously).
 */
export function groupFilesByEpisodeNumber<T extends { name: string }>(
  files: T[]
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const file of files) {
    const parsed = parseEpisodeFileName(file.name);
    if (!parsed) continue;
    const list = grouped.get(parsed.episode) ?? [];
    list.push(file);
    grouped.set(parsed.episode, list);
  }
  return grouped;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

export function isVideoFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return false;
  return VIDEO_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

// Plex's exact inline-extras suffix convention: "Descriptive Name-Type.ext",
// hyphen immediately before the type, no space, type immediately before the
// extension. See support.plex.tv/articles/local-files-for-trailers-and-extras.
const EXTRA_SUFFIXES = [
  "behindthescenes",
  "deleted",
  "featurette",
  "interview",
  "scene",
  "short",
  "trailer",
  "other",
];
const EXTRA_SUFFIX_RE = new RegExp(`-(?:${EXTRA_SUFFIXES.join("|")})\\.[^.]+$`, "i");

/**
 * A movie folder's video files are otherwise all treated as playback
 * segments of the same movie (there's no per-file naming convention like
 * shows have) — without this, a "Trailer-trailer.mp4" sitting alongside
 * the real movie file gets appended to it as if it were another part.
 * Also applied to episode files for the same reason (a "-deleted.mp4"
 * scene would otherwise look like an episode's real segment).
 *
 * Plex also supports extras organized into subfolders (e.g. "Trailers/",
 * "Behind The Scenes/") rather than filename suffixes — those need no
 * separate handling here, since the scanner only ever lists *files*
 * directly inside a movie/season folder, never recursing into subfolders,
 * so an extras subfolder is already invisible to it.
 */
export function isExtraFile(fileName: string): boolean {
  return EXTRA_SUFFIX_RE.test(fileName);
}

// ── Audiobooks ───────────────────────────────────────────────────────────
// Layout: <Author>/<Book (Year)>/files, optionally <Author>/<Series>/<Book>.
// A book's audio files (or its CD1/CD2 subfolders' files) play as one
// continuous timeline, exactly like a split movie.

const AUDIO_EXTENSIONS = new Set([".m4b", ".m4a", ".mp3"]);

export function isAudioFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return false;
  return AUDIO_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

/**
 * Orders a book's audio files into playback parts. Explicit split suffixes
 * (part/pt/cd/disc N) win; everything else compares numerically-aware, so
 * "Chapter 2" sorts before "Chapter 10" (plain localeCompare wouldn't).
 */
export function orderAudioParts<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const aPart = SPLIT_RE.exec(a.name)?.[1];
    const bPart = SPLIT_RE.exec(b.name)?.[1];
    if (aPart && bPart && Number(aPart) !== Number(bPart)) return Number(aPart) - Number(bPart);
    if (aPart && !bPart) return -1;
    if (!aPart && bPart) return 1;
    return compareNames(a.name, b.name);
  });
}

const DISC_FOLDER_RE = /^(?:cd|disc|disk|dvd|part|pt)[\s._-]*0*(\d+)(?:[\s._-].*)?$/i;

/** "CD1", "Disc 2", "Part 03", "Disk_1 - Chapters 1-10" → the disc number; anything else → null. */
export function parseDiscFolderNumber(folderName: string): number | null {
  const match = DISC_FOLDER_RE.exec(folderName.trim());
  return match ? Number(match[1]) : null;
}

export function isDiscFolderName(folderName: string): boolean {
  return parseDiscFolderNumber(folderName) !== null;
}

/**
 * Flattens a book split across disc/part subfolders into one ordered file
 * list: loose files first, then each disc folder in disc-number order (name
 * as the tiebreak), files within each ordered by orderAudioParts.
 */
export function orderBookParts<T extends { name: string }>(
  looseFiles: T[],
  discFolders: { name: string; files: T[] }[]
): T[] {
  const discs = [...discFolders].sort(
    (a, b) =>
      (parseDiscFolderNumber(a.name) ?? 0) - (parseDiscFolderNumber(b.name) ?? 0) ||
      compareNames(a.name, b.name)
  );
  return [...orderAudioParts(looseFiles), ...discs.flatMap((d) => orderAudioParts(d.files))];
}

export interface ParsedBookFolder {
  name: string;
  year: number | null;
  /** From a "Book 3 - " / "03 - " prefix, leading zeros stripped ("03" → "3", "1.5" kept). */
  seriesPosition: string | null;
  /** From a Plex-style {asin-B0XXXXXXXX} tag, which skips fuzzy matching. */
  asin: string | null;
}

const ASIN_TAG_RE = /\{asin-([A-Z0-9]{10})\}/i;
const BOOK_POSITION_RE = /^(?:(book|vol(?:ume)?\.?|#)\s*)?(\d+(?:\.\d+)?)\s*[-–—.:]\s*(?=\S)/i;

/** Parses "Book 1 - The Way of Kings (2010) {asin-B003P2WO5E}" into its parts. */
export function parseBookFolderName(folderName: string): ParsedBookFolder {
  let name = folderName.trim();

  let asin: string | null = null;
  const asinMatch = ASIN_TAG_RE.exec(name);
  if (asinMatch) {
    asin = asinMatch[1].toUpperCase();
    name = name.replace(ASIN_TAG_RE, "").trim();
  }

  let year: number | null = null;
  const yearMatch = /\s*\((\d{4})\)\s*$/.exec(name);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    name = name.slice(0, yearMatch.index).trim();
  }

  let seriesPosition: string | null = null;
  const posMatch = BOOK_POSITION_RE.exec(name);
  // Without an explicit "Book"/"Vol"/"#" prefix, only treat a short number
  // as a position, so a title like "1984 - Special Edition" isn't mangled.
  if (posMatch && (posMatch[1] || posMatch[2].split(".")[0].length <= 3)) {
    seriesPosition = posMatch[2].replace(/^0+(?=\d)/, "");
    name = name.slice(posMatch[0].length).trim();
  }

  return { name: name || folderName.trim(), year, seriesPosition, asin };
}
