/**
 * Browsing a video library like a file manager. A video title's `folder_path` is the folder it
 * sits in, relative to the library root ('' = the root). Subfolders are derived from the titles
 * the viewer can actually see (library access and age limit applied BEFORE grouping), so a folder
 * that is empty or holds only hidden videos never appears and its name never leaks.
 */
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, photoFavorites, titles, watchState } from "@/lib/db/schema";
import { FILE_TREE_KINDS } from "@/lib/libraries/profile";
import { groupMatch, type GroupKind } from "@/lib/libraries/audio-groups";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const MAX_PATH_LENGTH = 1024;
const MAX_DEPTH = 32;
const MAX_FOLDERS = 1000;

/**
 * Validates a folder path from a URL. '' (or missing) is the library root. Anything odd
 * (empty segments, '.', '..', backslashes, control characters, a leading or trailing '/', too
 * long or too deep; the scanner stores folder names with those characters replaced) is rejected with null, so callers answer the same 404 as for a folder
 * that doesn't exist.
 */
export function normalizeFolderPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw.length > MAX_PATH_LENGTH) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  const segments = raw.split("/");
  if (segments.length > MAX_DEPTH) return null;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.join("/");
}

/** Breadcrumb trail for a normalized path: each segment with the path that opens it. */
export function folderTrail(path: string): { name: string; path: string }[] {
  if (path === "") return [];
  const segments = path.split("/");
  return segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join("/") }));
}

/** The folder one level up ('' for a top-level folder; null at the root). */
export function parentFolder(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// ── Sorting a folder's files ─────────────────────────────────────────────

export type FolderSortKey = "name" | "duration" | "artist";
export interface FolderSort {
  key: FolderSortKey;
  dir: "asc" | "desc";
}
export const FOLDER_SORT_KEYS: readonly FolderSortKey[] = ["name", "duration", "artist"];
const DEFAULT_FOLDER_DIR: Record<FolderSortKey, "asc" | "desc"> = { name: "asc", artist: "asc", duration: "desc" };
export const DEFAULT_FOLDER_SORT: FolderSort = { key: "name", dir: "asc" };

/** A sort from URL parameters; anything unrecognised is the default (by name), and a missing direction is the key's usual one. */
export function parseFolderSort(key: string | null | undefined, dir: string | null | undefined): FolderSort {
  const k = FOLDER_SORT_KEYS.find((x) => x === key);
  if (!k) return DEFAULT_FOLDER_SORT;
  return { key: k, dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_FOLDER_DIR[k] };
}

/** The query-string part for a sort ("sort=duration&dir=desc&"), empty for the default so ordinary links stay clean. */
export function folderSortQuery(sort: FolderSort): string {
  return sort.key === DEFAULT_FOLDER_SORT.key && sort.dir === DEFAULT_FOLDER_SORT.dir ? "" : `sort=${sort.key}&dir=${sort.dir}&`;
}

/** The longest search the folder views take. */
export const MAX_FOLDER_SEARCH = 64;

/** A search from a URL: trimmed, limited in length, null when there is nothing to look for. */
export function parseFolderSearch(raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_FOLDER_SEARCH);
  return text === "" ? null : text;
}

/**
 * The address of a library page: the extra query it always carries, the sort, a search, and the folder - in a fixed order so links are
 * stable. The default sort and an empty search leave nothing in the address.
 */
export function folderLink(args: { base: string; extra?: string; path?: string; sort?: FolderSort; q?: string | null }): string {
  const parts = [
    args.extra ? args.extra.replace(/&$/, "") : "",
    args.sort ? folderSortQuery(args.sort).replace(/&$/, "") : "",
    args.q ? `q=${encodeURIComponent(args.q)}` : "",
    args.path ? `path=${encodeURIComponent(args.path)}` : "",
  ].filter(Boolean);
  return parts.length ? `${args.base}?${parts.join("&")}` : args.base;
}

/** SQL: the file's name, artist, album (its tags') or folder contains the text (case-insensitive, `%` and `_` taken literally). */
function matchesSearch(text: string) {
  const like = `%${escapeLike(text)}%`;
  return sql`(${titles.name} ILIKE ${like} ESCAPE '\\' OR coalesce(${titles.authors}::text, '') ILIKE ${like} ESCAPE '\\' OR coalesce(${titles.seriesName}, '') ILIKE ${like} ESCAPE '\\' OR coalesce(${titles.folderPath}, '') ILIKE ${like} ESCAPE '\\')`;
}

/** The value a file sorts by, as text so one cursor shape fits every sort: ties fall back to the file name's natural order. */
function sortValue(sort: FolderSort) {
  const name = sql`coalesce(${titles.sortKey}, lower(${titles.name}))`;
  if (sort.key === "duration") return sql<string>`lpad(coalesce(${titles.runtimeSeconds}, 0)::text, 10, '0') || chr(1) || ${name}`;
  if (sort.key === "artist") return sql<string>`coalesce(lower(${titles.authors}->>0), '') || chr(1) || ${name}`;
  return sql<string>`${name}`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface FolderItem {
  id: string;
  /** A photo library holds pictures and videos together; every other file-tree library is all one kind. */
  kind: "movie" | "audiobook" | "photo" | "ebook";
  name: string;
  year: number | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
  /** Audio files: the artist(s), shown under the title; null for video. */
  authors: string[] | null;
  /** Pictures: their size, for laying out a grid; null when unknown or not a picture. */
  width: number | null;
  height: number | null;
  /** Whether the viewer asking has hearted it (photo libraries). */
  favorite: boolean;
  /** Whether the viewer asking has watched, listened to or read it (marked or finished). */
  watched: boolean;
}

export interface FolderPage {
  /** Immediate subfolders (names), only on the first page. */
  folders: string[];
  items: FolderItem[];
  nextCursor: { key: string; id: string } | null;
}

/**
 * One level of a video library: its subfolders and one page of the videos directly inside.
 * Null means "no such library or folder as far as this viewer is concerned" (hidden library,
 * non-video library, or a folder with nothing visible in it other than the root).
 */
export async function listFolder(
  ex: Db,
  args: {
    actor: LibraryActor;
    viewer: AccessProfile;
    /** The profile asking, so items they hearted can be marked (photo libraries). */
    viewerId?: string;
    libraryId: string;
    path: string;
    limit?: number;
    after?: { key: string; id: string } | null;
    /** How the files are ordered (by name when omitted); a cursor is only good for the sort it came from. */
    sort?: FolderSort;
    /** Looks through the whole library for files whose name, artist, album or folder contain this text (the folder `path` is then ignored, and no subfolders are listed). */
    search?: string | null;
    /** Lists every file of the library (the folder `path` is ignored, no subfolders): a Songs / Tracks view. */
    all?: boolean;
    /** Only the files of one artist, album or genre (across the whole library, like `all`). */
    group?: { kind: GroupKind; name: string } | null;
  }
): Promise<FolderPage | null> {
  const limit = Math.min(Math.max(args.limit ?? 60, 1), 200);
  const visible = and(
    eq(titles.libraryId, args.libraryId),
    inArray(libraries.kind, [...FILE_TREE_KINDS]),
    libraryVisible(ex, args.actor),
    contentFilter(args.viewer, titles.ratingAges)
  );

  const depth = args.path === "" ? 0 : args.path.split("/").length;
  const below =
    args.path === ""
      ? sql`${titles.folderPath} <> ''`
      : sql`${titles.folderPath} LIKE ${escapeLike(args.path) + "/%"} ESCAPE '\\'`;

  const firstPage = !args.after;
  // A search, a whole-library list and a group all look across folders: no folder is "here", and none are listed.
  const searching = !!args.search || !!args.all || !!args.group;
  const folderRows = firstPage && !searching
    ? await ex
        .selectDistinct({ name: sql<string>`split_part(${titles.folderPath}, '/', ${depth + 1})` })
        .from(titles)
        .innerJoin(libraries, eq(libraries.id, titles.libraryId))
        .where(and(visible, below))
        .limit(MAX_FOLDERS)
    : [];

  const here = args.path;
  // What the files are ordered by (by default the natural-order key: the file name with padded numbers; titles scanned before it existed fall back to their name).
  const sort = args.sort ?? DEFAULT_FOLDER_SORT;
  const listKey = sortValue(sort);
  const descending = sort.dir === "desc";
  const itemRows = await ex
    .select({
      id: titles.id,
      kind: titles.kind,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
      runtimeSeconds: titles.runtimeSeconds,
      authors: titles.authors,
      width: titles.width,
      height: titles.height,
      favorite: args.viewerId ? sql<boolean>`EXISTS (SELECT 1 FROM ${photoFavorites} f WHERE f.title_id = ${titles.id} AND f.viewer_id = ${args.viewerId})` : sql<boolean>`false`,
      watched: args.viewerId ? sql<boolean>`EXISTS (SELECT 1 FROM ${watchState} w WHERE w.owner_kind = 'title' AND w.owner_id = ${titles.id} AND w.viewer_id = ${args.viewerId} AND w.finished)` : sql<boolean>`false`,
      listKey,
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        visible,
        searching ? undefined : sql`coalesce(${titles.folderPath}, '') = ${here}`,
        args.search ? matchesSearch(args.search) : undefined,
        args.group ? groupMatch(args.group.kind, args.group.name) : undefined,
        args.after
          ? or(descending ? sql`${listKey} < ${args.after.key}` : sql`${listKey} > ${args.after.key}`, and(sql`${listKey} = ${args.after.key}`, descending ? lt(titles.id, args.after.id) : gt(titles.id, args.after.id)))
          : undefined
      )
    )
    .orderBy(descending ? desc(listKey) : asc(listKey), descending ? desc(titles.id) : asc(titles.id))
    .limit(limit + 1);

  const folders = folderRows.map((r) => r.name).filter((n) => n !== "").sort((a, b) => collator.compare(a, b));
  const page = itemRows.slice(0, limit);
  const last = page[page.length - 1];

  // A non-root folder with nothing visible in it (no videos, no visible subfolders) doesn't exist for this viewer.
  if (!searching && args.path !== "" && firstPage && folders.length === 0 && page.length === 0) return null;
  // The library itself must be visible and of the right kind even when it's empty: a library with
  // no visible titles at the root is an empty page, but only for a library that passes the checks.
  if ((searching || args.path === "") && firstPage && folders.length === 0 && page.length === 0) {
    const [lib] = await ex
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, args.libraryId), inArray(libraries.kind, [...FILE_TREE_KINDS]), libraryVisible(ex, args.actor)))
      .limit(1);
    if (!lib) return null;
  }

  return {
    folders,
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind === "photo" ? "photo" : r.kind === "audiobook" ? "audiobook" : r.kind === "ebook" ? "ebook" : "movie",
      name: r.name,
      year: r.year,
      posterUrl: r.posterUrl,
      runtimeSeconds: r.runtimeSeconds,
      authors: r.authors,
      width: r.width,
      height: r.height,
      favorite: r.favorite === true,
      watched: r.watched === true,
    })),
    nextCursor: itemRows.length > limit && last ? { key: last.listKey, id: last.id } : null,
  };
}

/** The most ids "select all" in a folder or music view reads. */
export const MAX_SELECT_IDS = 5000;

/**
 * The ids of every playable file directly in a folder (all pages of it, in the order the folder is shown), for "select all" - the same
 * visibility as listFolder. Pictures and books are not playable and are left out. Null when the library isn't visible to this viewer.
 */
export async function folderPlayableIds(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string; path: string; max?: number; sort?: FolderSort; search?: string | null; all?: boolean; group?: { kind: GroupKind; name: string } | null }
): Promise<{ ids: string[]; truncated: boolean } | null> {
  const max = args.max ?? MAX_SELECT_IDS;
  const sort = args.sort ?? DEFAULT_FOLDER_SORT;
  const listKey = sortValue(sort);
  const [lib] = await ex
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, args.libraryId), inArray(libraries.kind, [...FILE_TREE_KINDS]), libraryVisible(ex, args.actor)))
    .limit(1);
  if (!lib) return null;
  const rows = await ex
    .select({ id: titles.id })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        eq(titles.libraryId, args.libraryId),
        inArray(titles.kind, ["movie", "audiobook"]),
        args.search || args.all || args.group ? undefined : sql`coalesce(${titles.folderPath}, '') = ${args.path}`,
        args.search ? matchesSearch(args.search) : undefined,
        args.group ? groupMatch(args.group.kind, args.group.name) : undefined,
        libraryVisible(ex, args.actor),
        contentFilter(args.viewer, titles.ratingAges)
      )
    )
    .orderBy(sort.dir === "desc" ? desc(listKey) : asc(listKey), sort.dir === "desc" ? desc(titles.id) : asc(titles.id))
    .limit(max + 1);
  return { ids: rows.slice(0, max).map((r) => r.id), truncated: rows.length > max };
}
