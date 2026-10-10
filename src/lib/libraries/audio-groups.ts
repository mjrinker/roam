/**
 * Grouping an audio or music library's songs by artist, album or genre, from the tags the scan read (artist = the first author, album =
 * the series name, genre = the genres list). A group is named by its text, compared ignoring case and edge spaces; songs with none
 * fall into one "Unknown" group. Pure grouping first, then the query that feeds it.
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titles } from "@/lib/db/schema";
import { isSongLibraryKind } from "@/lib/libraries/profile";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type GroupKind = "artist" | "album" | "genre";
export const GROUP_KINDS: readonly GroupKind[] = ["artist", "album", "genre"];
/** The group name in an address for songs that have no artist, album or genre. */
export const UNKNOWN_GROUP = "__unknown__";
/** The most songs read to build the groups of one library. */
const MAX_ROWS = 50_000;

export interface AudioGroup {
  /** What goes in the address (the text itself, or UNKNOWN_GROUP). */
  name: string;
  /** What is shown ("Unknown artist" for the unknown group). */
  label: string;
  count: number;
  coverUrl: string | null;
}

export interface SongRow {
  id: string;
  authors: string[] | null;
  seriesName: string | null;
  genres: string[] | null;
  posterUrl: string | null;
}

const UNKNOWN_LABEL: Record<GroupKind, string> = { artist: "Unknown artist", album: "Unknown album", genre: "Unknown genre" };
const norm = (s: string | null | undefined) => (s ?? "").trim();

/** The text(s) a song is grouped under for this kind (an empty list means it belongs to the unknown group). */
function valuesOf(row: SongRow, kind: GroupKind): string[] {
  if (kind === "artist") return norm(row.authors?.[0]) ? [norm(row.authors?.[0])] : [];
  if (kind === "album") return norm(row.seriesName) ? [norm(row.seriesName)] : [];
  return (row.genres ?? []).map(norm).filter(Boolean);
}

/** Which spelling of a name to show when songs spell it differently: the most common, then a mixed-case one over ALL CAPS or all lower, then plain order. */
function bestSpelling(spellings: ReadonlyMap<string, number>): string {
  const flat = (t: string) => (t === t.toLowerCase() || t === t.toUpperCase() ? 1 : 0);
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || flat(a[0]) - flat(b[0]) || (a[0] < b[0] ? -1 : 1))[0][0];
}

/** The groups the songs fall into, A to Z by name (case and accents aside), the unknown group last. */
export function groupSongs(rows: readonly SongRow[], kind: GroupKind): AudioGroup[] {
  const groups = new Map<string, { spellings: Map<string, number>; count: number; coverUrl: string | null }>();
  for (const row of rows) {
    const values = valuesOf(row, kind);
    // Each distinct (case-insensitive) value once; a song with none is in the unknown group.
    const distinct = new Map<string, string>();
    for (const v of values) if (!distinct.has(v.toLowerCase())) distinct.set(v.toLowerCase(), v);
    const entries: [string, string | null][] = distinct.size > 0 ? [...distinct.entries()] : [[UNKNOWN_GROUP, null]];
    for (const [key, value] of entries) {
      const group = groups.get(key) ?? { spellings: new Map(), count: 0, coverUrl: null };
      if (value !== null) group.spellings.set(value, (group.spellings.get(value) ?? 0) + 1);
      group.count++;
      group.coverUrl ??= row.posterUrl;
      groups.set(key, group);
    }
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const out: AudioGroup[] = [...groups.entries()].map(([key, g]) => {
    const name = key === UNKNOWN_GROUP ? UNKNOWN_GROUP : bestSpelling(g.spellings);
    return { name, label: key === UNKNOWN_GROUP ? UNKNOWN_LABEL[kind] : name, count: g.count, coverUrl: g.coverUrl };
  });
  return out.sort((a, b) => (a.name === UNKNOWN_GROUP ? 1 : b.name === UNKNOWN_GROUP ? -1 : collator.compare(a.label, b.label)));
}

/** SQL: the song belongs to this group (the same test `groupSongs` uses, so a group's count and its songs agree). */
export function groupMatch(kind: GroupKind, name: string): SQL {
  const unknown = name === UNKNOWN_GROUP;
  if (kind === "artist") return unknown ? sql`coalesce(trim(${titles.authors}->>0), '') = ''` : sql`lower(trim(${titles.authors}->>0)) = lower(${name})`;
  if (kind === "album") return unknown ? sql`coalesce(trim(${titles.seriesName}), '') = ''` : sql`lower(trim(${titles.seriesName})) = lower(${name})`;
  return unknown
    ? sql`jsonb_array_length(coalesce(${titles.genres}, '[]'::jsonb)) = 0`
    : sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(${titles.genres}, '[]'::jsonb)) g WHERE lower(trim(g)) = lower(${name}))`;
}

/**
 * The artists, albums or genres of a library's songs, one page A to Z. `after` is the last group name of the previous page. Null when the
 * library isn't one this viewer can see (or isn't an audio or music library).
 */
export async function listAudioGroups(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string; kind: GroupKind; limit?: number; after?: string | null }
): Promise<{ items: AudioGroup[]; next: string | null } | null> {
  const [lib] = await ex
    .select({ id: libraries.id, kind: libraries.kind })
    .from(libraries)
    .where(and(eq(libraries.id, args.libraryId), libraryVisible(ex, args.actor)))
    .limit(1);
  if (!lib || !isSongLibraryKind(lib.kind)) return null;
  const rows = await ex
    .select({ id: titles.id, authors: titles.authors, seriesName: titles.seriesName, genres: titles.genres, posterUrl: titles.posterUrl })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(titles.libraryId, args.libraryId), eq(titles.kind, "audiobook"), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges)))
    .orderBy(asc(titles.id))
    .limit(MAX_ROWS);
  const all = groupSongs(rows, args.kind);
  const limit = Math.min(Math.max(args.limit ?? 120, 1), 500);
  const start = args.after ? all.findIndex((g) => g.name === args.after) + 1 : 0;
  const page = all.slice(start, start + limit);
  return { items: page, next: start + limit < all.length ? page[page.length - 1].name : null };
}
