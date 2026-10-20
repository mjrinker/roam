/**
 * Plex's ".plexmatch" match-hint files (support.plex.tv/articles/plexmatch): a line-delimited text file in a series folder (or a season
 * folder) that says what the folder is, so a library can be read without renaming anything. Names are case-insensitive, "#" starts a comment.
 *
 *   title / show     the series' title        year      its release year
 *   tmdbid / tvdbid / imdbid                  the series' id        season   the season this folder holds
 *   episode / ep     "S01E02: file.mkv", "SP03: file.mkv", "02: file.mkv", with a range ("S01E01-E02") for a file of several episodes
 *   pattern / pt     "Show Part {se} - {ep} - *" with {s}/{season}, {e}/{ep}/{episode}, {sp}/{special}, {see}, a validity range, an offset
 *                    and a length ("{sp,1-3,+4}", "{e,l2}"), and * wildcards
 *
 * Pure: parsing and matching only.
 */

export interface EpisodeHint {
  /** The file the hint is for: its name, or a path relative to the .plexmatch file's folder. */
  file: string;
  /** A season the hint names (SP means season 0), or null for the folder's season. */
  season: number | null;
  episodes: number[];
}

export interface PatternHint {
  regex: RegExp;
  tokens: { kind: "season" | "episode" | "special" | "see"; min: number; max: number; offset: number }[];
}

export interface PlexMatch {
  title: string | null;
  year: number | null;
  season: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  episodes: EpisodeHint[];
  patterns: PatternHint[];
}

export const emptyPlexMatch = (): PlexMatch => ({ title: null, year: null, season: null, tmdbId: null, tvdbId: null, imdbId: null, episodes: [], patterns: [] });

const MAX_LINES = 5000;

const intOf = (v: string) => (/^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : null);

/** "S03E04", "E02", "02", "SP04", each with an optional "-E05" / "-05" / "-S03E06" continuation: the season (null: the folder's) and the episodes. */
export function parseEpisodeNumber(text: string): { season: number | null; episodes: number[] } | null {
  const t = text.trim();
  const sp = /^sp0*(\d+)$/i.exec(t);
  if (sp) return { season: 0, episodes: [Number(sp[1])] };
  const m = /^(?:s0*(\d+))?\s*e?0*(\d+)(?:-(?:s0*\d+)?e?0*(\d+))?$/i.exec(t);
  if (!m) return null;
  const first = Number(m[2]);
  const last = m[3] === undefined ? first : Number(m[3]);
  // The "S" form needs its "E"; a bare "S03" is not an episode.
  if (m[1] !== undefined && !/e/i.test(t)) return null;
  if (last < first || last - first > 100) return { season: m[1] === undefined ? null : Number(m[1]), episodes: [first] };
  return { season: m[1] === undefined ? null : Number(m[1]), episodes: Array.from({ length: last - first + 1 }, (_, i) => first + i) };
}

/** Turns a pattern ("Show Part {se} - {ep} - *") into something that can be matched against file names. Null when it has no episode token. */
export function compilePattern(pattern: string): PatternHint | null {
  const tokens: PatternHint["tokens"] = [];
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (c === "*") {
      source += ".*";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) return null;
      const [name, ...params] = pattern.slice(i + 1, end).split(",").map((p) => p.trim());
      const kind = /^(?:s|se|season)$/i.test(name) ? "season" : /^(?:e|ep|episode)$/i.test(name) ? "episode" : /^(?:sp|special)$/i.test(name) ? "special" : /^see$/i.test(name) ? "see" : null;
      if (!kind) return null;
      let min = 0;
      let max = Infinity;
      let offset = 0;
      let length = 9;
      for (const p of params) {
        const range = /^(\d+)-(\d+)$/.exec(p);
        const off = /^([+-])(\d+)$/.exec(p);
        const len = /^l(\d+)$/i.exec(p);
        if (range) [min, max] = [Number(range[1]), Number(range[2])];
        else if (off) offset = Number(off[2]) * (off[1] === "-" ? -1 : 1);
        else if (len) length = Math.max(1, Number(len[1]));
      }
      tokens.push({ kind, min, max, offset });
      source += `(\\d{1,${length}})`;
      i = end;
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  if (!tokens.some((t) => t.kind === "episode" || t.kind === "special" || t.kind === "see")) return null;
  return { regex: new RegExp(`^${source}$`, "i"), tokens };
}

/** What a pattern says about a path (relative to the folder the .plexmatch is in), or null when it doesn't match or a value is out of range. */
export function matchPattern(hint: PatternHint, relativePath: string): { season: number | null; episodes: number[] } | null {
  const noExt = relativePath.replace(/\\.[A-Za-z0-9]{1,5}$/, "");
  const m = hint.regex.exec(relativePath) ?? hint.regex.exec(noExt) ?? matchWithExtension(hint, relativePath);
  if (!m) return null;
  let season: number | null = null;
  let episode: number | null = null;
  for (let i = 0; i < hint.tokens.length; i++) {
    const t = hint.tokens[i];
    const raw = Number(m[i + 1]);
    if (raw < t.min || raw > t.max) return null;
    const value = raw + t.offset;
    if (t.kind === "season") season = value;
    else if (t.kind === "episode") episode = value;
    else if (t.kind === "special") {
      season = 0;
      episode = value;
    } else {
      season = Math.floor(value / 100);
      episode = value % 100;
    }
  }
  return episode === null ? null : { season, episodes: [episode] };
}

// A pattern may name the file with its extension ("Bonus {sp}.mp4") or without it ("Bonus {sp}").
function matchWithExtension(hint: PatternHint, path: string): RegExpExecArray | null {
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(path)?.[0];
  return ext ? new RegExp(`^${hint.regex.source.slice(1, -1)}\\${ext}$`, "i").exec(path) : null;
}

export function parsePlexMatch(text: string): PlexMatch {
  const out = emptyPlexMatch();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, MAX_LINES);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (value === "") continue;
    switch (name) {
      case "title":
      case "show":
        out.title = value.slice(0, 200);
        break;
      case "year":
        out.year = intOf(value);
        break;
      case "season":
        out.season = intOf(value);
        break;
      case "tmdbid":
        out.tmdbId = intOf(value);
        break;
      case "tvdbid":
        out.tvdbId = intOf(value);
        break;
      case "imdbid":
        out.imdbId = /^(?:tt)?\d+$/i.test(value) ? (value.toLowerCase().startsWith("tt") ? value.toLowerCase() : `tt${value}`) : null;
        break;
      case "episode":
      case "ep": {
        // "S03E04: file.mkv": the number is up to the first colon, the file after it.
        const split = value.indexOf(":");
        if (split <= 0) break;
        const number = parseEpisodeNumber(value.slice(0, split));
        const file = value.slice(split + 1).trim().replace(/\\/g, "/");
        if (number && file) out.episodes.push({ file, season: number.season, episodes: number.episodes });
        break;
      }
      case "pattern":
      case "pt": {
        const compiled = compilePattern(value);
        if (compiled) out.patterns.push(compiled);
        break;
      }
    }
  }
  return out;
}

/**
 * What a folder's hints say about one file: an `episode` hint naming it (by name, or by path from the folder), else the first pattern that
 * matches. Null when nothing does, and the file is numbered by its own name.
 */
export function hintForFile(match: PlexMatch, relativePath: string): { season: number | null; episodes: number[] } | null {
  const wanted = relativePath.replace(/\\/g, "/").toLowerCase();
  const hinted = match.episodes.find((e) => e.file.toLowerCase() === wanted);
  if (hinted) return { season: hinted.season, episodes: hinted.episodes };
  for (const p of match.patterns) {
    const hit = matchPattern(p, relativePath.replace(/\\/g, "/"));
    if (hit) return hit;
  }
  return null;
}
