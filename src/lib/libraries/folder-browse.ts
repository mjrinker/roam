/**
 * Browsing a video library like a file manager. A video title's `folder_path` is the folder it
 * sits in, relative to the library root ('' = the root). Subfolders are derived from the titles
 * the viewer can actually see (library access and age limit applied BEFORE grouping), so a folder
 * that is empty or holds only hidden videos never appears and its name never leaks.
 */
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titles } from "@/lib/db/schema";

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

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface FolderItem {
  id: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
}

export interface FolderPage {
  /** Immediate subfolders (names), only on the first page. */
  folders: string[];
  items: FolderItem[];
  nextCursor: { name: string; id: string } | null;
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
    libraryId: string;
    path: string;
    limit?: number;
    after?: { name: string; id: string } | null;
  }
): Promise<FolderPage | null> {
  const limit = Math.min(Math.max(args.limit ?? 60, 1), 200);
  const visible = and(
    eq(titles.libraryId, args.libraryId),
    eq(libraries.kind, "video"),
    libraryVisible(ex, args.actor),
    contentFilter(args.viewer, titles.ratingAges)
  );

  const depth = args.path === "" ? 0 : args.path.split("/").length;
  const below =
    args.path === ""
      ? sql`${titles.folderPath} <> ''`
      : sql`${titles.folderPath} LIKE ${escapeLike(args.path) + "/%"} ESCAPE '\\'`;

  const firstPage = !args.after;
  const folderRows = firstPage
    ? await ex
        .selectDistinct({ name: sql<string>`split_part(${titles.folderPath}, '/', ${depth + 1})` })
        .from(titles)
        .innerJoin(libraries, eq(libraries.id, titles.libraryId))
        .where(and(visible, below))
        .limit(MAX_FOLDERS)
    : [];

  const here = args.path;
  const itemRows = await ex
    .select({
      id: titles.id,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
      runtimeSeconds: titles.runtimeSeconds,
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        visible,
        sql`coalesce(${titles.folderPath}, '') = ${here}`,
        args.after ? or(gt(titles.name, args.after.name), and(eq(titles.name, args.after.name), gt(titles.id, args.after.id))) : undefined
      )
    )
    .orderBy(asc(titles.name), asc(titles.id))
    .limit(limit + 1);

  const folders = folderRows.map((r) => r.name).filter((n) => n !== "").sort((a, b) => collator.compare(a, b));
  const page = itemRows.slice(0, limit);
  const last = page[page.length - 1];

  // A non-root folder with nothing visible in it (no videos, no visible subfolders) doesn't exist for this viewer.
  if (args.path !== "" && firstPage && folders.length === 0 && page.length === 0) return null;
  // The library itself must be visible and of the right kind even when it's empty: a library with
  // no visible titles at the root is an empty page, but only for a library that passes the checks.
  if (args.path === "" && firstPage && folders.length === 0 && page.length === 0) {
    const [lib] = await ex
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, args.libraryId), eq(libraries.kind, "video"), libraryVisible(ex, args.actor)))
      .limit(1);
    if (!lib) return null;
  }

  return {
    folders,
    items: page,
    nextCursor: itemRows.length > limit && last ? { name: last.name, id: last.id } : null,
  };
}
