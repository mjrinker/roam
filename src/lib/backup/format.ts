/**
 * What a profile can take with it and bring back: what it has watched, its ratings, labels and watch list, in a portable form (titles are
 * named by TMDB id, name and year, never by this server's own ids), plus readers for other services' files (Letterboxd's CSV exports, and a
 * plain CSV anyone can make). Pure: parsing and building only.
 */

export type ItemKind = "movie" | "show" | "episode";

export interface TitleRef {
  kind: "movie" | "show";
  title: string;
  year: number | null;
  tmdbId: number | null;
}

export interface EpisodeRef extends Omit<TitleRef, "kind"> {
  kind: "episode";
  season: number;
  number: number;
}

export type ItemRef = TitleRef | EpisodeRef;

export interface WatchedEntry {
  ref: ItemRef;
  finished: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  /** ISO time of the last watch, when known. */
  at: string | null;
}

export interface ProfileData {
  watched: WatchedEntry[];
  ratings: { ref: ItemRef; halfStars: number }[];
  labels: { name: string; titles: TitleRef[] }[];
  watchlist: TitleRef[];
}

export const emptyData = (): ProfileData => ({ watched: [], ratings: [], labels: [], watchlist: [] });

export const FORMAT_NAME = "roam-profile";

/** The file a profile downloads. */
export function buildExport(data: ProfileData, info: { profileName: string; serverName: string; now: Date }): string {
  return JSON.stringify({ format: FORMAT_NAME, version: 1, exportedAt: info.now.toISOString(), profile: info.profileName, server: info.serverName, ...data }, null, 1);
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ParseResult = { ok: true; data: ProfileData; source: string } | { ok: false; error: string };

const MAX_ITEMS = 50_000;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

function refFrom(raw: unknown): ItemRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title);
  if (!title || (r.kind !== "movie" && r.kind !== "show" && r.kind !== "episode")) return null;
  const base = { title, year: int(r.year), tmdbId: int(r.tmdbId) };
  if (r.kind === "episode") {
    const season = int(r.season);
    const number = int(r.number);
    return season === null || number === null ? null : { kind: "episode", ...base, season, number };
  }
  return { kind: r.kind, ...base };
}

const titleRefFrom = (raw: unknown): TitleRef | null => {
  const r = refFrom(raw);
  return r && r.kind !== "episode" ? r : null;
};

/** Reads a file this app wrote. */
export function parseRoamJson(text: string): ParseResult {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "That isn't a Roam export (it isn't JSON)." };
  }
  if (!doc || doc.format !== FORMAT_NAME) return { ok: false, error: "That isn't a Roam export." };
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
  const data = emptyData();
  for (const w of list(doc.watched)) {
    const ref = refFrom((w as Record<string, unknown>)?.ref);
    const e = w as Record<string, unknown>;
    if (ref) data.watched.push({ ref, finished: e.finished === true, positionSeconds: Math.max(0, int(e.positionSeconds) ?? 0), durationSeconds: int(e.durationSeconds), at: typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) ? e.at : null });
  }
  for (const r of list(doc.ratings)) {
    const e = r as Record<string, unknown>;
    const ref = refFrom(e?.ref);
    const halfStars = int(e?.halfStars);
    if (ref && halfStars !== null && halfStars >= 1 && halfStars <= 10) data.ratings.push({ ref, halfStars });
  }
  for (const l of list(doc.labels)) {
    const e = l as Record<string, unknown>;
    const name = str(e?.name);
    if (name) data.labels.push({ name, titles: list(e.titles).map(titleRefFrom).filter((t): t is TitleRef => t !== null) });
  }
  data.watchlist = list(doc.watchlist).map(titleRefFrom).filter((t): t is TitleRef => t !== null);
  return { ok: true, data, source: "Roam" };
}

/** CSV with quoted fields, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
    if (rows.length > MAX_ITEMS) break;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const headerIndex = (header: string[]) => {
  const map = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  return (...names: string[]) => names.map((n) => map.get(n)).find((i) => i !== undefined);
};

/**
 * Reads a CSV: Letterboxd's watched.csv and ratings.csv (Date, Name, Year, Letterboxd URI, Rating), or a plain one with the columns
 * type (movie or episode), title, year, season, episode, rating (0.5 to 5) and watched (yes, or a date).
 */
export function parseCsvImport(text: string): ParseResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, error: "That file has nothing in it to import." };
  const col = headerIndex(rows[0]);
  const nameAt = col("name", "title");
  if (nameAt === undefined) return { ok: false, error: "I don't recognise that file: it needs a Name (or title) column." };
  const yearAt = col("year");
  const ratingAt = col("rating");
  const typeAt = col("type", "kind");
  const seasonAt = col("season");
  const episodeAt = col("episode", "number");
  const watchedAt = col("watched", "date", "watched date");
  const letterboxd = col("letterboxd uri") !== undefined;
  const data = emptyData();
  for (const r of rows.slice(1)) {
    const title = str(r[nameAt]);
    if (!title) continue;
    const year = yearAt === undefined ? null : int(r[yearAt]);
    const type = typeAt === undefined ? "movie" : str(r[typeAt]).toLowerCase();
    const season = seasonAt === undefined ? null : int(r[seasonAt]);
    const number = episodeAt === undefined ? null : int(r[episodeAt]);
    const ref: ItemRef = type === "episode" && season !== null && number !== null ? { kind: "episode", title, year, tmdbId: null, season, number } : { kind: type === "show" ? "show" : "movie", title, year, tmdbId: null };
    const stars = ratingAt === undefined ? null : Number(r[ratingAt]);
    const hasRating = stars !== null && Number.isFinite(stars) && stars > 0;
    if (hasRating) data.ratings.push({ ref, halfStars: Math.min(10, Math.max(1, Math.round(stars * 2))) });
    // A Letterboxd ratings file lists films that were rated (so also seen); watched.csv lists what was seen; a plain file says so.
    const date = watchedAt === undefined ? "" : str(r[watchedAt]);
    const seen = letterboxd ? true : watchedAt === undefined ? !hasRating : !/^(no|false|0)$/i.test(date) && date !== "";
    if (seen) data.watched.push({ ref, finished: true, positionSeconds: 0, durationSeconds: null, at: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null });
  }
  return { ok: true, data, source: letterboxd ? "Letterboxd" : "CSV" };
}

/** Works out what a file is and reads it. */
export function parseImport(text: string): ParseResult {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return parseRoamJson(text);
  return parseCsvImport(text);
}
