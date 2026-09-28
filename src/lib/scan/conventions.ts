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
 * - A multi-episode file ("S01E05-E06", or the shorthand "S01E05-06") is
 *   recognized and attached to EVERY episode number it spans (capped at
 *   MAX_EPISODES_PER_FILE) — each gets its own row, and each plays an
 *   estimated slice of the shared file (see lib/scan/episode-split.ts).
 *   A standalone file for one of those numbers always wins over a
 *   combined file's claim on it (see groupEpisodeFiles).
 */

import { compareNames } from "./cursor";

const TITLE_YEAR_RE = /^(.*?)\s*\((\d{4})\)\s*$/;
const SEASON_FOLDER_RE = /season\s*0*(\d+)/i;
// Group 3 greedily collects every "-e?NN" continuation directly after the
// first episode number (Plex's multi-episode form: "-E06", "-E06-E07", or
// the bare shorthand "-06" — never space- or no-separator-joined, which
// isn't a real Plex convention). Group 4 is the trailing " - Title" part,
// same as before.
const EPISODE_FILE_RE = /s0*(\d+)e0*(\d+)((?:-e?\d+(?=[-.\s]|$))*)(?:\s*-\s*(.+?))?(?:\.[^.]+)?$/i;
// One "-e?NN" continuation token, captured separately from the main regex
// above so a multi-episode file's episode list can be pulled out of its
// (variable-length) group 3 blob.
const EPISODE_CONTINUATION_RE = /-(e?)(\d+)/gi;
/** How many consecutive episodes one physical file may span — a sanity cap against a garbage match, not a real-world limit. */
export const MAX_EPISODES_PER_FILE = 4;

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
  /** The first (or only) episode number — kept for callers that only ever cared about one. */
  episode: number;
  /** Every episode number this file spans, in order. `[episode]` for an ordinary single-episode file. */
  episodes: number[];
  name: string | null;
}

/**
 * The episode numbers a multi-episode continuation blob (regex group 3,
 * e.g. "-E06-E07" or "-06") spans, starting from `start` — or just
 * `[start]` if the blob is empty, invalid, or spans more than
 * MAX_EPISODES_PER_FILE. Two encodings, both from Plex's own convention:
 *   - a SINGLE token — bare "-06" or explicit "-E06", doesn't matter which
 *     — is shorthand for "through episode NN" (an inclusive range end),
 *     not "and also episode NN"; it needs no consecutiveness check of its
 *     own beyond simply being greater than `start`.
 *   - MULTIPLE explicit "-e?NN" tokens each name the NEXT episode, and
 *     each one must be exactly consecutive ("-E06-E07" from a start of 5
 *     means 5,6,7) — this is what actually needs the strict check, so a
 *     stray non-consecutive tag (e.g. "-E06-E09") isn't silently treated
 *     as a valid range.
 */
function expandEpisodeRange(start: number, continuationBlob: string): number[] {
  const tokens = [...continuationBlob.matchAll(EPISODE_CONTINUATION_RE)].map((m) => Number(m[2]));
  if (tokens.length === 0) return [start];

  let end: number;
  let validSequence: boolean;
  if (tokens.length === 1) {
    // Single token, either form: an inclusive range end, not a strict
    // "next consecutive integer" — "-E06" straight after "E01" means
    // "episodes 1 through 6", exactly like the bare "-06" shorthand does.
    end = tokens[0];
    validSequence = end > start;
  } else {
    const sequence = [start, ...tokens];
    validSequence = sequence.every((v, i) => i === 0 || v === sequence[i - 1] + 1);
    end = tokens[tokens.length - 1];
  }
  if (!validSequence || end - start + 1 > MAX_EPISODES_PER_FILE) return [start];

  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Parses "S01E01 - Pilot.mp4" -> { season: 1, episode: 1, episodes: [1], name: "Pilot" },
 * or a multi-episode file "S01E05-E06 - Title.mp4" ->
 * { season: 1, episode: 5, episodes: [5, 6], name: "Title" }.
 */
export function parseEpisodeFileName(fileName: string): ParsedEpisodeFile | null {
  const match = EPISODE_FILE_RE.exec(fileName.trim());
  if (!match) return null;
  const season = Number(match[1]);
  const episode = Number(match[2]);
  const episodes = expandEpisodeRange(episode, match[3] ?? "");
  let name = match[4]?.trim() || null;
  if (name && SUPPRESSED_TITLE_RE.test(name)) name = null;
  return { season, episode, episodes, name };
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

export interface EpisodeFileGroup<T> {
  files: T[];
  /** True if this group's files are a multi-episode file (e.g. "S01E05-E06") claiming this episode number. */
  combined: boolean;
}

/**
 * Groups a season folder's video files by episode number, so multi-part
 * episodes (S01E01 - part1.mp4 / part2.mp4) collapse into one episode with
 * ordered segments instead of one row overwriting another, and multi-episode
 * files (S01E05-E06) attach to every episode number they span. Files that
 * don't match the SxxExx convention are dropped (same as the scanner
 * silently skipping them file-by-file previously).
 *
 * A standalone single-episode file always wins over a combined file's claim
 * on the same episode number — e.g. a lone "S01E05.mp4" alongside a
 * combined "S01E05-E06.mp4" means episode 5 plays only the standalone file,
 * and episode 6 plays the combined file whole (the split pass in
 * episode-split.ts sees the owner mismatch and leaves it untrimmed).
 * Combined files sharing the exact same episode span (e.g. two parts of the
 * same "S01E05-E06 - pt1/pt2") group together as one multi-part block.
 * When two DIFFERENT spans claim the same episode number, the lowest
 * starting episode wins, then the shortest span, then string order — some
 * deterministic choice has to be made, and this one is stable across scans.
 */
export function groupEpisodeFiles<T extends { name: string }>(
  files: T[]
): Map<number, EpisodeFileGroup<T>> {
  const singles = new Map<number, T[]>();
  const combos = new Map<number, Map<string, T[]>>();
  for (const file of files) {
    const parsed = parseEpisodeFileName(file.name);
    if (!parsed) continue;
    if (parsed.episodes.length === 1) {
      const list = singles.get(parsed.episode) ?? [];
      list.push(file);
      singles.set(parsed.episode, list);
    } else {
      const key = parsed.episodes.join("-");
      for (const ep of parsed.episodes) {
        const bySpan = combos.get(ep) ?? new Map<string, T[]>();
        const list = bySpan.get(key) ?? [];
        list.push(file);
        bySpan.set(key, list);
        combos.set(ep, bySpan);
      }
    }
  }

  const allEpisodeNumbers = new Set<number>([...singles.keys(), ...combos.keys()]);
  const out = new Map<number, EpisodeFileGroup<T>>();
  for (const ep of [...allEpisodeNumbers].sort((a, b) => a - b)) {
    const standalone = singles.get(ep);
    if (standalone) {
      out.set(ep, { files: orderMediaSegments(standalone), combined: false });
      continue;
    }
    const spans = combos.get(ep)!;
    const bestKey = [...spans.keys()].sort(
      (a, b) =>
        Number(a.split("-")[0]) - Number(b.split("-")[0]) ||
        a.split("-").length - b.split("-").length ||
        a.localeCompare(b)
    )[0];
    out.set(ep, { files: orderMediaSegments(spans.get(bestKey)!), combined: true });
  }
  return out;
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
  /** Narrator(s) from a trailing "[Narrator Name]" tag; empty if there is none. */
  narrators: string[];
}

const ASIN_TAG_RE = /\{asin-([A-Z0-9]{10})\}/i;
const BOOK_POSITION_RE = /^(?:(book|vol(?:ume)?\.?|#)\s*)?(\d+(?:\.\d+)?)\s*[-–—.:]\s*(?=\S)/i;

// Bracketed tags that aren't narrators: "[Unabridged]", "[2016]", "[HQ]", "[m4b]" …
const NOT_A_NARRATOR_RE =
  /^(?:un)?abridged$|^audiobook$|^audio$|^hq$|^hd$|^m4b$|^m4a$|^mp3$|^flac$|^complete$|^full cast$|^dramatized(?: adaptation)?$|^\d[\d\s.:-]*$/i;
const NARRATOR_NAME_RE = /^\p{L}[\p{L}\p{M}.'\u2019 -]{1,60}$/u;
const TRAILING_SPLIT_RE = /\s*[-_.]?\s*(?:cd|disc|disk|part|pt)\s*0*\d+\s*$/i;

/**
 * Reads a trailing "[Narrator Name]" (or "[Read by A & B]") from a folder or
 * file base name (no extension), returning the name without it. Several
 * narrators may be separated by commas, "&", "and" or ";". Anything in
 * brackets that doesn't look like a person (years, "Unabridged", format
 * tags) is left alone.
 */
export function parseNarratorTag(baseName: string): { rest: string; narrators: string[] } | null {
  // "Title [Narrator] - pt2": look past a trailing split marker.
  const split = TRAILING_SPLIT_RE.exec(baseName);
  const body = split ? baseName.slice(0, split.index) : baseName;

  const match = /^(.*\S)\s*\[([^\]]+)\]\s*$/.exec(body);
  if (!match) return null;

  const raw = match[2].trim().replace(/^(?:narrated by|read by|narrator:?)\s+/i, "");
  const narrators = raw
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
  if (
    narrators.length === 0 ||
    !narrators.every((n) => NARRATOR_NAME_RE.test(n) && !NOT_A_NARRATOR_RE.test(n))
  ) {
    return null;
  }
  // Keep a split marker that followed the tag with the remainder.
  return { rest: match[1].trim() + (split ? baseName.slice(split.index) : ""), narrators };
}

/**
 * The narrator a book's files name, e.g. "Project Hail Mary [Ray Porter].m4b".
 * Takes the most common tag across the files (ties go to the first), then
 * falls back to `fallback` (typically the folder name's tag).
 */
export function extractNarratorHint(fileNames: string[], fallback: string[] = []): string[] | null {
  const counts = new Map<string, { narrators: string[]; count: number }>();
  for (const fileName of fileNames) {
    const dot = fileName.lastIndexOf(".");
    const tag = parseNarratorTag(dot > 0 ? fileName.slice(0, dot) : fileName);
    if (!tag) continue;
    const key = tag.narrators.join("|").toLowerCase();
    const entry = counts.get(key) ?? { narrators: tag.narrators, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  let best: { narrators: string[]; count: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  if (best) return best.narrators;
  return fallback.length > 0 ? fallback : null;
}

/** Parses "Book 1 - The Way of Kings (2010) {asin-B003P2WO5E}" into its parts. */
export function parseBookFolderName(folderName: string): ParsedBookFolder {
  let name = folderName.trim();

  let asin: string | null = null;
  const asinMatch = ASIN_TAG_RE.exec(name);
  if (asinMatch) {
    asin = asinMatch[1].toUpperCase();
    name = name.replace(ASIN_TAG_RE, "").trim();
  }

  // A "(2010)" year and a "[Narrator]" tag can trail the name in either order.
  let year: number | null = null;
  let narrators: string[] = [];
  for (let i = 0; i < 3; i++) {
    const yearMatch = /\s*\((\d{4})\)\s*$/.exec(name);
    if (yearMatch && year === null) {
      year = Number(yearMatch[1]);
      name = name.slice(0, yearMatch.index).trim();
      continue;
    }
    const tag = parseNarratorTag(name);
    if (tag && narrators.length === 0) {
      narrators = tag.narrators;
      name = tag.rest;
      continue;
    }
    break;
  }

  let seriesPosition: string | null = null;
  const posMatch = BOOK_POSITION_RE.exec(name);
  // Without an explicit "Book"/"Vol"/"#" prefix, only treat a short number
  // as a position, so a title like "1984 - Special Edition" isn't mangled.
  if (posMatch && (posMatch[1] || posMatch[2].split(".")[0].length <= 3)) {
    seriesPosition = posMatch[2].replace(/^0+(?=\d)/, "");
    name = name.slice(posMatch[0].length).trim();
  }

  return { name: name || folderName.trim(), year, seriesPosition, asin, narrators };
}
