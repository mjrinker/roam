import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titleCast, titles } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface CastMember {
  personId: number;
  name: string;
  character: string | null;
  photoUrl: string | null;
}

/** A movie's or show's billed cast, top-billed first. (The caller has already checked the viewer may see the title.) */
export async function loadTitleCast(ex: Db, titleId: string): Promise<CastMember[]> {
  return ex
    .select({ personId: titleCast.personId, name: titleCast.name, character: titleCast.character, photoUrl: titleCast.photoUrl })
    .from(titleCast)
    .where(eq(titleCast.titleId, titleId))
    .orderBy(asc(titleCast.position));
}

export interface PersonPage {
  personId: number;
  name: string;
  photoUrl: string | null;
  /** The movies and shows on this server with this person in the cast, that this viewer may see; newest first. */
  items: { id: string; kind: "movie" | "show"; name: string; year: number | null; posterUrl: string | null; character: string | null }[];
}

/** A person and their movies and shows on this server, or null when none of them is one this actor and viewer can see. */
export async function loadPersonPage(ex: Db, actor: LibraryActor, viewer: AccessProfile, personId: number): Promise<PersonPage | null> {
  const rows = await ex
    .select({
      id: titles.id,
      kind: titles.kind,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
      personName: titleCast.name,
      photoUrl: titleCast.photoUrl,
      character: titleCast.character,
    })
    .from(titleCast)
    .innerJoin(titles, eq(titleCast.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titleCast.personId, personId), inArray(titles.kind, ["movie", "show"]), libraryVisible(ex, actor), contentFilter(viewer, titles.ratingAges)))
    .orderBy(sql`${titles.year} DESC NULLS LAST`, asc(titles.name), desc(titles.id));
  if (rows.length === 0) return null;
  const withPhoto = rows.find((r) => r.photoUrl) ?? rows[0];
  return {
    personId,
    name: rows[0].personName,
    photoUrl: withPhoto.photoUrl,
    items: rows.map((r) => ({ id: r.id, kind: r.kind as "movie" | "show", name: r.name, year: r.year, posterUrl: r.posterUrl, character: r.character })),
  };
}
