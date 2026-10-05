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
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titles } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const timelineCursorSchema = z.object({ t: z.number().int().nullable(), id: z.string().uuid() });
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
}

export interface TimelinePage {
  items: TimelineItem[];
  next: TimelineCursor | null;
}

const MAX_PAGE = 200;

/** Library access, the age limit, and "this really is a photo library", for items of `libraryId`. */
function visibleItems(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string }) {
  return and(
    eq(titles.libraryId, args.libraryId),
    eq(libraries.kind, "photos"),
    libraryVisible(ex, args.actor),
    contentFilter(args.viewer, titles.ratingAges)
  );
}

const at = (t: number) => sql`to_timestamp(${t}::double precision)`;

/** Items strictly after `cursor` in timeline order (older, then NULL dates last). */
function afterCursor(cursor: TimelineCursor): SQL {
  if (cursor.t === null) return and(isNull(titles.takenAt), lt(titles.id, cursor.id))!;
  return or(lt(titles.takenAt, at(cursor.t)), and(sql`${titles.takenAt} = ${at(cursor.t)}`, lt(titles.id, cursor.id)), isNull(titles.takenAt))!;
}

/** One page of a photo library's timeline, or null when the viewer can't see such a library. */
export async function listTimeline(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string; after?: TimelineCursor | null; limit?: number }
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
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(visibleItems(ex, args), args.after ? afterCursor(args.after) : undefined))
    .orderBy(sql`${titles.takenAt} DESC NULLS LAST`, desc(titles.id))
    .limit(limit + 1);

  // An empty first page still needs the library itself to be visible and a photo library.
  if (rows.length === 0 && !args.after) {
    const [library] = await ex
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, args.libraryId), eq(libraries.kind, "photos"), libraryVisible(ex, args.actor)))
      .limit(1);
    if (!library) return null;
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind === "movie" ? "movie" : "photo",
      name: r.name,
      takenAt: r.takenAt ? r.takenAt.toISOString() : null,
      width: r.width,
      height: r.height,
      posterUrl: r.posterUrl,
      runtimeSeconds: r.runtimeSeconds,
    })),
    next: rows.length > limit && last ? { t: last.takenAt ? Math.floor(last.takenAt.getTime() / 1000) : null, id: last.id } : null,
  };
}

export interface PhotoDetail {
  id: string;
  libraryId: string;
  libraryName: string;
  name: string;
  takenAt: Date | null;
  width: number | null;
  height: number | null;
  folderPath: string;
  sortKey: string;
}

/** One picture's details, or null when it doesn't exist, isn't a picture in a photo library, or isn't visible to this viewer. */
export async function loadPhoto(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; id: string }): Promise<PhotoDetail | null> {
  const [row] = await ex
    .select({
      id: titles.id,
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
    .where(and(eq(titles.id, args.id), eq(titles.kind, "photo"), eq(libraries.kind, "photos"), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges)))
    .limit(1);
  if (!row) return null;
  return { ...row, folderPath: row.folderPath ?? "" };
}

export type NeighborScope = { kind: "timeline" } | { kind: "folder"; path: string };

/**
 * The pictures either side of `photo` (videos are skipped: the viewer is for pictures), by date for
 * the timeline or by name within the folder. `prev` is the one shown before it, `next` the one after.
 * Only items this viewer may see are considered, so nothing hidden is ever offered.
 */
export async function photoNeighbors(
  ex: Db,
  args: { actor: LibraryActor; viewer: AccessProfile; photo: PhotoDetail; scope: NeighborScope }
): Promise<{ prev: string | null; next: string | null }> {
  const { photo } = args;
  const base = and(visibleItems(ex, { ...args, libraryId: photo.libraryId }), eq(titles.kind, "photo"));
  const pick = async (where: SQL | undefined, order: SQL[]) => {
    const [row] = await ex
      .select({ id: titles.id })
      .from(titles)
      .innerJoin(libraries, eq(libraries.id, titles.libraryId))
      .where(and(base, where))
      .orderBy(...order)
      .limit(1);
    return row?.id ?? null;
  };

  if (args.scope.kind === "timeline") {
    // Never-dated items have no place in the timeline order, so they have no neighbours.
    if (!photo.takenAt) return { prev: null, next: null };
    const t = Math.floor(photo.takenAt.getTime() / 1000);
    const dated = isNotNull(titles.takenAt);
    return {
      next: await pick(and(dated, or(lt(titles.takenAt, at(t)), and(sql`${titles.takenAt} = ${at(t)}`, lt(titles.id, photo.id)))), [desc(titles.takenAt), desc(titles.id)]),
      prev: await pick(and(dated, or(gt(titles.takenAt, at(t)), and(sql`${titles.takenAt} = ${at(t)}`, gt(titles.id, photo.id)))), [asc(titles.takenAt), asc(titles.id)]),
    };
  }

  const key = sql`coalesce(${titles.sortKey}, lower(${titles.name}))`;
  const here = sql`coalesce(${titles.folderPath}, '') = ${args.scope.path}`;
  return {
    next: await pick(and(here, or(sql`${key} > ${photo.sortKey}`, and(sql`${key} = ${photo.sortKey}`, gt(titles.id, photo.id)))), [asc(key), asc(titles.id)]),
    prev: await pick(and(here, or(sql`${key} < ${photo.sortKey}`, and(sql`${key} = ${photo.sortKey}`, lt(titles.id, photo.id)))), [desc(key), desc(titles.id)]),
  };
}
