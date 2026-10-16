import { and, eq, inArray, sql } from "drizzle-orm";
import { libraries, titles } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import type { Executor } from "./executor";
import { SMART_LIBRARY_KINDS } from "./smart";

/** The genres across the movies, shows, books and songs this profile can see (library sharing and age limit), A to Z (for the genre choice of a smart playlist). */
export async function visibleGenres(ex: Executor, actor: LibraryActor, viewer: AccessProfile): Promise<string[]> {
  const rows = await ex
    .selectDistinct({ name: sql<string>`g.value` })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .innerJoin(sql`jsonb_array_elements_text(${titles.genres}) AS g(value)`, sql`true`)
    .where(and(libraryVisible(ex, actor), contentFilter(viewer, titles.ratingAges), inArray(titles.kind, ["movie", "show", "audiobook"])))
    .orderBy(sql`g.value`)
    .limit(400);
  return rows.map((r) => r.name).filter((n) => n.trim().length > 0 && n.length <= 60);
}

/** The libraries this profile can see that a smart playlist can draw from (movies, TV, music, audio and audiobooks), by name. */
export async function visibleSmartLibraries(ex: Executor, actor: LibraryActor): Promise<{ id: string; name: string; kind: string }[]> {
  const rows = await ex
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(and(libraryVisible(ex, actor), inArray(libraries.kind, [...SMART_LIBRARY_KINDS])))
    .orderBy(sql`lower(${libraries.name})`);
  return rows;
}
