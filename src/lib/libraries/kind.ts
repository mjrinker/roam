/** Which kind of library a title lives in, for code that must treat generic video libraries differently. */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, titles, type LibraryKind } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The kind of the library that holds `titleId`, or null if the title doesn't exist. */
export async function libraryKindOfTitle(ex: Db, titleId: string): Promise<LibraryKind | null> {
  const [row] = await ex
    .select({ kind: libraries.kind })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(eq(titles.id, titleId))
    .limit(1);
  return row?.kind ?? null;
}

/**
 * Video ("generic") libraries get everything from the files themselves: no TMDB or Audible
 * matching, no folder-based resync, and their titles' `box_folder_id` is a file key, not a folder.
 */
export const isVideoLibraryKind = (kind: LibraryKind | null): boolean => kind === "video";

export const NOT_FOR_VIDEO_LIBRARIES = "This isn't available for videos in a video library.";
