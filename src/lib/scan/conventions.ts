/**
 * Parses the folder/file naming conventions the scanner expects in Box.
 * See the "Organization in Box" section of the project plan.
 *
 *   Movies:  Movie Title (2001)/Movie Title (2001).mp4
 *            Movie Title (2001)/part1.mp4, part2.mp4, ...
 *   Shows:   Show Name/Season 01/S01E01 - Episode Title.mp4
 */

const TITLE_YEAR_RE = /^(.*?)\s*\((\d{4})\)\s*$/;
const PART_RE = /part\s*0*(\d+)/i;
const SEASON_FOLDER_RE = /season\s*0*(\d+)/i;
const EPISODE_FILE_RE = /s0*(\d+)e0*(\d+)(?:\s*-\s*(.+?))?(?:\.[^.]+)?$/i;

export interface ParsedTitleFolder {
  name: string;
  year: number | null;
}

/** Parses a movie/show folder name like "The Matrix (1999)" -> { name, year }. */
export function parseTitleFolderName(folderName: string): ParsedTitleFolder {
  const match = TITLE_YEAR_RE.exec(folderName.trim());
  if (match) {
    return { name: match[1].trim(), year: Number(match[2]) };
  }
  return { name: folderName.trim(), year: null };
}

/** Parses "Season 01", "Season 1" -> 1. Returns null if it doesn't match. */
export function parseSeasonFolderName(folderName: string): number | null {
  const match = SEASON_FOLDER_RE.exec(folderName.trim());
  return match ? Number(match[1]) : null;
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
  return {
    season: Number(match[1]),
    episode: Number(match[2]),
    name: match[3]?.trim() || null,
  };
}

/**
 * Given the files directly inside a movie or episode folder, returns them
 * ordered into playback segments. A file matching "partN" (any position in
 * the name) is ordered by N; anything else falls back to alphabetical order.
 * A single video file simply becomes part index 0.
 */
export function orderMediaSegments<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const aPart = PART_RE.exec(a.name)?.[1];
    const bPart = PART_RE.exec(b.name)?.[1];
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
