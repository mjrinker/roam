/**
 * Reading a photo library: the timeline (newest first by date taken), the neighbours of a photo for
 * previous/next, and one photo's details. Every query applies library access and the viewer's age
 * limit BEFORE anything is selected, ordered or paged, so a hidden or age-blocked item never shows up
 * and is never revealed as "the next one".
 *
 * Order is (taken_at desc, id desc). taken_at is whole seconds by construction (scan truncates it and
 * EXIF has no fractions), so a cursor of {epoch seconds, id} is exact; it is "wall-clock time as UTC"
 * (see exif.ts), which is why the page formats it in UTC.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, photoFavorites, titles } from "@/lib/db/schema";
import { PHOTO_LIBRARY_KINDS } from "@/lib/libraries/profile";
import { escapeLike, type SearchSpec } from "@/lib/photos/search";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const timelineCursorSchema = z.object({
  // Years 1 to 9999: anything else would only make Postgres refuse the timestamp.
  t: z.number().int().min(-62135596800).max(253402300799).nullable(),
  id: z.string().uuid(),
});
export type TimelineCursor = z.infer<typeof timelineCursorSchema>;

export interface TimelineItem {
  id: string;
  /** A picture, or a video that sits beside the pictures. */
  kind: "photo" | "movie";
  name: string;
  /** ISO time, wall-clock as UTC (see above); null only for an item that was never dated. */
  takenAt: string | null;
  width: number | null;
  height: number | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
  /** Whether the viewer asking has hearted it. */
  favorite: boolean;
  /** What the viewer's details panel shows (so opening an item needs no further request). */
  filename: string | null;
  sizeBytes: number | null;
  container: string | null;
  folderPath: string;
}

export interface TimelinePage {
  items: TimelineItem[];
  /** The cursor for the next OLDER page, or null at the end. */
  next: TimelineCursor | null;
  /** The cursor for the next NEWER page (only when asked to start part-way, or when paging upward), or null at the top. */
  prev?: TimelineCursor | null;
}

const MAX_PAGE = 200;

/** Library access, the age limit, and "this really is a photo library", for items of `libraryId`. */
function visibleItems(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string }) {
  return and(
    eq(titles.libraryId, args.libraryId),
    inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS]),
    libraryVisible(ex, args.actor),
    contentFilter(args.viewer, titles.ratingAges)
  );
}

const at = (t: number) => sql`to_timestamp(${t}::double precision)`;

/** Items strictly BEFORE `cursor` in timeline order (newer; a dated cursor never has undated items before it). */
function beforeCursor(cursor: TimelineCursor): SQL {
  if (cursor.t === null) return or(isNotNull(titles.takenAt), and(isNull(titles.takenAt), gt(titles.id, cursor.id)))!;
  return or(gt(titles.takenAt, at(cursor.t)), and(sql`${titles.takenAt} = ${at(cursor.t)}`, gt(titles.id, cursor.id)))!;
}

/** Items strictly after `cursor` in timeline order (older, then NULL dates last). */
function afterCursor(cursor: TimelineCursor): SQL {
  if (cursor.t === null) return and(isNull(titles.takenAt), lt(titles.id, cursor.id))!;
  return or(lt(titles.takenAt, at(cursor.t)), and(sql`${titles.takenAt} = ${at(cursor.t)}`, lt(titles.id, cursor.id)), isNull(titles.takenAt))!;
}

/** Starting a page at a month (and older) or at the undated items. A bad value is ignored, not an error. */
function monthStart(month: string | null | undefined): SQL | undefined {
  if (!month) return undefined;
  if (month === "undated") return isNull(titles.takenAt);
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[1] < 1826 || +m[1] > 9998) return undefined;
  const nextMonth = new Date(Date.UTC(+m[1], +m[2], 1));
  return or(lt(titles.takenAt, sql`${nextMonth.toISOString()}::timestamptz`), isNull(titles.takenAt));
}

/**
 * Everything a listing is narrowed by, in one place so the timeline, the favorites view, search and the
 * scrubber's month counts can never disagree about what a viewer may see: visibility and age first, then
 * the optional favorites and search narrowing.
 */
function narrowed(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; viewerId?: string; libraryId: string; favoritesOnly?: boolean; search?: SearchSpec | null }
): SQL | undefined {
  const heart = args.viewerId ? sql`EXISTS (SELECT 1 FROM ${photoFavorites} f WHERE f.title_id = ${titles.id} AND f.viewer_id = ${args.viewerId})` : sql`false`;
  const search = args.search
    ? args.search.range
      ? or(sql`${titles.name} ILIKE ${"%" + escapeLike(args.search.text) + "%"} ESCAPE '\\'`, and(sql`${titles.takenAt} >= ${args.search.range.from.toISOString()}::timestamptz`, sql`${titles.takenAt} < ${args.search.range.to.toISOString()}::timestamptz`))
      : sql`${titles.name} ILIKE ${"%" + escapeLike(args.search.text) + "%"} ESCAPE '\\'`
    : undefined;
  return and(visibleItems(ex, args), args.favoritesOnly ? heart : undefined, search);
}

export interface MonthBucket {
  /** "2024-03", or "undated". */
  key: string;
  count: number;
}

/** How many visible items fall in each month (newest first, undated last), under the same narrowing as the listing. Null if the viewer can't see such a library. */
export async function listMonths(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; viewerId?: string; libraryId: string; favoritesOnly?: boolean; search?: SearchSpec | null }
): Promise<MonthBucket[] | null> {
  const key = sql<string>`coalesce(to_char(${titles.takenAt} AT TIME ZONE 'UTC', 'YYYY-MM'), 'undated')`;
  const rows = await ex
    .select({ key, count: sql<number>`count(*)::int` })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(narrowed(ex, args))
    .groupBy(key)
    .orderBy(sql`${key} DESC`);
  if (rows.length === 0) {
    const [library] = await ex
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, args.libraryId), inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS]), libraryVisible(ex, args.actor)))
      .limit(1);
    if (!library) return null;
  }
  // "undated" sorts after the digits in descending order already, but make the rule explicit.
  return rows.sort((a, b) => (a.key === "undated" ? 1 : b.key === "undated" ? -1 : b.key.localeCompare(a.key)));
}

/** One page of a photo library's timeline, or null when the viewer can't see such a library. */
export async function listTimeline(
  ex: Db,
  args: {
    actor: LibraryActor;
    viewer: AccessProfile;
    /** The profile asking (favorites are theirs). Without it nothing is marked and the favorites view is empty. */
    viewerId?: string;
    libraryId: string;
    after?: TimelineCursor | null;
    limit?: number;
    /** Only the viewer's favorites. */
    favoritesOnly?: boolean;
    /** Only items matching a search (by name, or by date if the query reads as one). */
    search?: SearchSpec | null;
    /** Start at this month ("2024-03", then older) or at the undated items ("undated"), for jumping with the scrubber. */
    month?: string | null;
    /** Return the page of items NEWER than this cursor instead (for scrolling up after a jump), in display order. */
    before?: TimelineCursor | null;
  }
): Promise<TimelinePage | null> {
  const limit = Math.min(Math.max(args.limit ?? 60, 1), MAX_PAGE);
  const rows = await ex
    .select({
      id: titles.id,
      kind: titles.kind,
      name: titles.name,
      takenAt: titles.takenAt,
      width: titles.width,
      height: titles.height,
      posterUrl: titles.posterUrl,
      runtimeSeconds: titles.runtimeSeconds,
      favorite: args.viewerId ? sql<boolean>`EXISTS (SELECT 1 FROM ${photoFavorites} f WHERE f.title_id = ${titles.id} AND f.viewer_id = ${args.viewerId})` : sql<boolean>`false`,
      filename: sql<string | null>`(SELECT m.filename FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      sizeBytes: sql<string | null>`(SELECT m.size_bytes::text FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      container: sql<string | null>`(SELECT m.container FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      folderPath: titles.folderPath,
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(narrowed(ex, args), args.after ? afterCursor(args.after) : undefined, args.before ? beforeCursor(args.before) : undefined, args.before ? undefined : monthStart(args.month)))
    // Paging upward asks for the nearest newer items, which is the reverse of display order; they are flipped back below.
    .orderBy(...(args.before ? [sql`${titles.takenAt} ASC NULLS FIRST`, sql`${titles.id} ASC NULLS FIRST`] : [sql`${titles.takenAt} DESC NULLS LAST`, sql`${titles.id} DESC NULLS LAST`]))
    .limit(limit + 1);

  // An empty first page still needs the library itself to be visible and a photo library.
  if (rows.length === 0 && !args.after) {
    const [library] = await ex
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, args.libraryId), inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS]), libraryVisible(ex, args.actor)))
      .limit(1);
    if (!library) return null;
  }

  const page = rows.slice(0, limit);
  if (args.before) page.reverse(); // back into display order: newest first
  const toItem = (r: (typeof rows)[number]): TimelineItem => ({
    id: r.id,
    kind: r.kind === "movie" ? "movie" : "photo",
    name: r.name,
    takenAt: r.takenAt ? r.takenAt.toISOString() : null,
    width: r.width,
    height: r.height,
    posterUrl: r.posterUrl,
    runtimeSeconds: r.runtimeSeconds,
    favorite: r.favorite === true,
    filename: r.filename,
    sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
    container: r.container,
    folderPath: r.folderPath ?? "",
  });
  const cursorOf = (r: { takenAt: Date | null; id: string }): TimelineCursor => ({ t: r.takenAt ? Math.floor(r.takenAt.getTime() / 1000) : null, id: r.id });
  const items = page.map(toItem);
  if (args.before) {
    // Paging up: more newer items exist if we got the extra row; the cursor for the next page up is the topmost item shown.
    return { items, next: null, prev: rows.length > limit && page[0] ? cursorOf(page[0]) : null };
  }
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? cursorOf(last) : null;
  // Starting part-way (a month jump) means there are newer items above that the page doesn't include.
  return { items, next, prev: args.month && !args.after && page[0] ? cursorOf(page[0]) : args.after ? undefined : null };
}

export interface PhotoDetail {
  id: string;
  /** A picture, or a video that sits beside the pictures: the viewer shows both. */
  kind: "photo" | "movie";
  runtimeSeconds: number | null;
  /** The file's name in Box, its size in bytes and its extension (for the info panel and zoom). */
  filename: string | null;
  sizeBytes: number | null;
  container: string | null;
  posterUrl: string | null;
  /** Whether the viewer asking has hearted it. */
  favorite: boolean;
  libraryId: string;
  libraryName: string;
  name: string;
  takenAt: Date | null;
  width: number | null;
  height: number | null;
  folderPath: string;
  sortKey: string;
}

/** One picture's or video's details, or null when it doesn't exist, isn't one in a photo library, or isn't visible to this viewer. */
export async function loadPhoto(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; viewerId?: string; id: string }): Promise<PhotoDetail | null> {
  const [row] = await ex
    .select({
      id: titles.id,
      kind: titles.kind,
      runtimeSeconds: titles.runtimeSeconds,
      posterUrl: titles.posterUrl,
      favorite: args.viewerId ? sql<boolean>`EXISTS (SELECT 1 FROM ${photoFavorites} f WHERE f.title_id = ${titles.id} AND f.viewer_id = ${args.viewerId})` : sql<boolean>`false`,
      filename: sql<string | null>`(SELECT m.filename FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      sizeBytes: sql<string | null>`(SELECT m.size_bytes::text FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      container: sql<string | null>`(SELECT m.container FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id} AND m.part_index = 0 LIMIT 1)`,
      libraryId: titles.libraryId,
      libraryName: libraries.name,
      name: titles.name,
      takenAt: titles.takenAt,
      width: titles.width,
      height: titles.height,
      folderPath: titles.folderPath,
      sortKey: sql<string>`coalesce(${titles.sortKey}, lower(${titles.name}))`,
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(titles.id, args.id), inArray(titles.kind, ["photo", "movie"]), inArray(libraries.kind, [...PHOTO_LIBRARY_KINDS]), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges)))
    .limit(1);
  if (!row) return null;
  return { ...row, favorite: row.favorite === true, kind: row.kind === "movie" ? "movie" : "photo", sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes), folderPath: row.folderPath ?? "" };
}

/** The item before or after a photo in the viewer: a picture or a video. */
export interface Neighbor {
  id: string;
  kind: "photo" | "movie";
  posterUrl: string | null;
}

export type NeighborScope = { kind: "timeline" } | { kind: "favorites"; viewerId: string } | { kind: "folder"; path: string };

/**
 * The pictures and videos either side of `photo`, by date for
 * the timeline or by name within the folder. `prev` is the one shown before it, `next` the one after.
 * Only items this viewer may see are considered, so nothing hidden is ever offered.
 */
export async function photoNeighbors(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; photo: PhotoDetail; scope: NeighborScope }
): Promise<{ prev: Neighbor | null; next: Neighbor | null }> {
  const { photo } = args;
  const base = and(
    visibleItems(ex, { ...args, libraryId: photo.libraryId }),
    inArray(titles.kind, ["photo", "movie"]),
    // Stepping through favorites only visits favorites (the viewer's own).
    args.scope.kind === "favorites" ? sql`EXISTS (SELECT 1 FROM ${photoFavorites} f WHERE f.title_id = ${titles.id} AND f.viewer_id = ${args.scope.viewerId})` : undefined
  );
  const pick = async (where: SQL | undefined, order: SQL[]) => {
    const [row] = await ex
      .select({ id: titles.id, kind: titles.kind, posterUrl: titles.posterUrl })
      .from(titles)
      .innerJoin(libraries, eq(libraries.id, titles.libraryId))
      .where(and(base, where))
      .orderBy(...order)
      .limit(1);
    return row ? { id: row.id, kind: row.kind === "movie" ? ("movie" as const) : ("photo" as const), posterUrl: row.posterUrl } : null;
  };

  if (args.scope.kind === "timeline" || args.scope.kind === "favorites") {
    // Never-dated items have no place in the timeline order, so they have no neighbours.
    if (!photo.takenAt) return { prev: null, next: null };
    const t = Math.floor(photo.takenAt.getTime() / 1000);
    const dated = isNotNull(titles.takenAt);
    return {
      next: await pick(and(dated, or(lt(titles.takenAt, at(t)), and(sql`${titles.takenAt} = ${at(t)}`, lt(titles.id, photo.id)))), [sql`${titles.takenAt} DESC NULLS LAST`, sql`${titles.id} DESC NULLS LAST`]),
      prev: await pick(and(dated, or(gt(titles.takenAt, at(t)), and(sql`${titles.takenAt} = ${at(t)}`, gt(titles.id, photo.id)))), [sql`${titles.takenAt} ASC NULLS FIRST`, sql`${titles.id} ASC NULLS FIRST`]),
    };
  }

  const key = sql`coalesce(${titles.sortKey}, lower(${titles.name}))`;
  const here = sql`coalesce(${titles.folderPath}, '') = ${args.scope.path}`;
  return {
    next: await pick(and(here, or(sql`${key} > ${photo.sortKey}`, and(sql`${key} = ${photo.sortKey}`, gt(titles.id, photo.id)))), [asc(key), asc(titles.id)]),
    prev: await pick(and(here, or(sql`${key} < ${photo.sortKey}`, and(sql`${key} = ${photo.sortKey}`, lt(titles.id, photo.id)))), [desc(key), desc(titles.id)]),
  };
}
