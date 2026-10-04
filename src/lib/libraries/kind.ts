/** Which kind of library a title lives in, for admin tools that only make sense for externally matched libraries. */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, titles, type LibraryKind } from "@/lib/db/schema";
import { libraryKindUsesExternalMetadata } from "@/lib/libraries/profile";

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

export const NOT_FOR_THIS_LIBRARY = "This isn't available for items in this kind of library.";

/**
 * For admin routes that call TMDB, Audible or treat the title's `box_folder_id` as a Box folder: the
 * response to send when the title is in a library that doesn't work that way, or null when it may
 * proceed. A POSITIVE allowlist (see lib/libraries/profile): a title in any library kind not named as
 * externally matched is refused, so a new kind is safe by default. Call it after the admin check.
 */
export async function refuseUnlessExternalMetadata(ex: Db, titleId: string): Promise<NextResponse | null> {
  const kind = await libraryKindOfTitle(ex, titleId);
  if (kind === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!libraryKindUsesExternalMetadata(kind)) return NextResponse.json({ error: NOT_FOR_THIS_LIBRARY }, { status: 400 });
  return null;
}
