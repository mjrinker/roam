/** Reading collections: only those in a library the profile can see, and only the titles its age limit allows. */
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { collectionItems, collections, libraries, titles } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A film series needs at least two of its films in the library to be worth a tile; one an admin made shows with one. */
export const SERIES_MIN = 2;

export interface CollectionCard {
  id: string;
  name: string;
  kind: "tmdb" | "manual";
  count: number;
  posterUrl: string | null;
}

export interface CollectionDetail {
  id: string;
  libraryId: string;
  libraryName: string;
  name: string;
  kind: "tmdb" | "manual";
  posterUrl: string | null;
  items: { id: string; kind: "movie" | "show" | "audiobook"; name: string; year: number | null; posterUrl: string | null }[];
}

const KINDS = ["movie", "show", "audiobook"] as const;

/** The collections of a library this profile can see, by name. */
export async function listCollections(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string }): Promise<CollectionCard[]> {
  const rows = await ex
    .select({
      id: collections.id,
      name: collections.name,
      kind: collections.kind,
      posterUrl: sql<string | null>`coalesce(${collections.posterUrl}, (array_agg(${titles.posterUrl} ORDER BY ${titles.year} ASC NULLS LAST) FILTER (WHERE ${titles.posterUrl} IS NOT NULL))[1])`,
      count: sql<number>`count(${titles.id})::int`,
    })
    .from(collections)
    .innerJoin(libraries, eq(libraries.id, collections.libraryId))
    .innerJoin(collectionItems, eq(collectionItems.collectionId, collections.id))
    .innerJoin(titles, and(eq(titles.id, collectionItems.titleId), contentFilter(args.viewer, titles.ratingAges)))
    .where(and(eq(collections.libraryId, args.libraryId), libraryVisible(ex, args.actor)))
    .groupBy(collections.id)
    .having(sql`count(${titles.id}) >= (CASE WHEN ${collections.kind} = 'tmdb' THEN ${SERIES_MIN} ELSE 1 END)`)
    .orderBy(asc(sql`lower(${collections.name})`));
  return rows;
}

/** One collection with the titles of it this profile can see (a series by year, a hand-made one in the order the admin set). Null when it can't be seen. */
export async function getCollection(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; collectionId: string }): Promise<CollectionDetail | null> {
  const [c] = await ex
    .select({ id: collections.id, name: collections.name, kind: collections.kind, posterUrl: collections.posterUrl, libraryId: libraries.id, libraryName: libraries.name })
    .from(collections)
    .innerJoin(libraries, eq(libraries.id, collections.libraryId))
    .where(and(eq(collections.id, args.collectionId), libraryVisible(ex, args.actor)))
    .limit(1);
  if (!c) return null;
  const items = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl })
    .from(collectionItems)
    .innerJoin(titles, and(eq(titles.id, collectionItems.titleId), contentFilter(args.viewer, titles.ratingAges)))
    .where(eq(collectionItems.collectionId, c.id))
    .orderBy(...(c.kind === "tmdb" ? [sql`${titles.year} ASC NULLS LAST`, sql`lower(${titles.name})`] : [asc(collectionItems.position), asc(collectionItems.addedAt)]));
  if (items.length === 0) return null;
  return { ...c, items: items.filter((i): i is typeof i & { kind: (typeof KINDS)[number] } => (KINDS as readonly string[]).includes(i.kind)) };
}

/** The collections this profile can see that hold a title (for "Part of …" on its page). */
export async function collectionsOfTitle(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; titleId: string }): Promise<{ id: string; name: string }[]> {
  const rows = await ex
    .select({ id: collections.id, name: collections.name, kind: collections.kind, visible: sql<number>`(SELECT count(*) FROM collection_items i2 JOIN titles t2 ON t2.id = i2.title_id WHERE i2.collection_id = ${collections.id} AND ${contentFilter(args.viewer, sql`t2.rating_ages`) ?? sql`true`})::int` })
    .from(collectionItems)
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .innerJoin(libraries, eq(libraries.id, collections.libraryId))
    .where(and(eq(collectionItems.titleId, args.titleId), libraryVisible(ex, args.actor)));
  return rows.filter((r) => r.visible >= (r.kind === "tmdb" ? SERIES_MIN : 1)).map((r) => ({ id: r.id, name: r.name }));
}
