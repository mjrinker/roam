import { and, eq, inArray, sql } from "drizzle-orm";
import { libraries, titles } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import type { Executor } from "./executor";

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
