/** Reading collections: only those in a library the profile can see, and only the titles its age limit allows. */
import { hasPlayableFile } from "@/lib/content/playable";
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
    .innerJoin(titles, and(eq(titles.id, collectionItems.titleId), contentFilter(args.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind)))
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
    .innerJoin(titles, and(eq(titles.id, collectionItems.titleId), contentFilter(args.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind)))
    .where(eq(collectionItems.collectionId, c.id))
    .orderBy(...(c.kind === "tmdb" ? [sql`${titles.year} ASC NULLS LAST`, sql`lower(${titles.name})`] : [asc(collectionItems.position), asc(collectionItems.addedAt)]));
  if (items.length === 0) return null;
  return { ...c, items: items.filter((i): i is typeof i & { kind: (typeof KINDS)[number] } => (KINDS as readonly string[]).includes(i.kind)) };
}

/** The collections this profile can see that hold a title (for "Part of …" on its page). */
export async function collectionsOfTitle(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; titleId: string }): Promise<{ id: string; name: string }[]> {
  const rows = await ex
    .select({ id: collections.id, name: collections.name, kind: collections.kind, visible: sql<number>`(SELECT count(*) FROM collection_items i2 JOIN titles t2 ON t2.id = i2.title_id WHERE i2.collection_id = ${collections.id} AND ${and(contentFilter(args.viewer, sql`t2.rating_ages`), hasPlayableFile(sql`t2.id`, sql`t2.kind`)) ?? sql`true`})::int` })
    .from(collectionItems)
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .innerJoin(libraries, eq(libraries.id, collections.libraryId))
    .where(and(eq(collectionItems.titleId, args.titleId), libraryVisible(ex, args.actor)));
  return rows.filter((r) => r.visible >= (r.kind === "tmdb" ? SERIES_MIN : 1)).map((r) => ({ id: r.id, name: r.name }));
}

export interface MoreInCollection {
  id: string;
  name: string;
  /** The other titles of it this profile can see (not the one asked about), in the collection's order. */
  items: CollectionDetail["items"];
}

/** For a title's page: each collection it is in, with the rest of what is in it. A collection with nothing else to show is left out. */
export async function moreInCollections(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; titleId: string }): Promise<MoreInCollection[]> {
  const out: MoreInCollection[] = [];
  for (const c of await collectionsOfTitle(ex, args)) {
    const detail = await getCollection(ex, { actor: args.actor, viewer: args.viewer, collectionId: c.id });
    const items = detail?.items.filter((i) => i.id !== args.titleId) ?? [];
    if (items.length > 0) out.push({ id: c.id, name: c.name, items });
  }
  return out;
}

export interface CollectionIndex {
  /** The collections worth a tile for this profile, by id. */
  cards: Record<string, CollectionCard>;
  /** For each title that is in one, the collection it is shown under (a film series before a hand-made one). */
  byTitle: Record<string, string>;
}

/** What a list needs to show collections as single tiles: which collections this profile sees, and which title belongs to which. */
export async function collectionIndex(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; libraryId: string }): Promise<CollectionIndex> {
  const cards = await listCollections(ex, args);
  if (cards.length === 0) return { cards: {}, byTitle: {} };
  const kinds = new Map(cards.map((c) => [c.id, c.kind]));
  const rows = await ex
    .select({ collectionId: collectionItems.collectionId, titleId: collectionItems.titleId })
    .from(collectionItems)
    .innerJoin(titles, and(eq(titles.id, collectionItems.titleId), contentFilter(args.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind)))
    .where(sql`${collectionItems.collectionId} IN (${sql.join(cards.map((c) => sql`${c.id}`), sql`, `)})`);
  const byTitle: Record<string, string> = {};
  for (const r of rows) {
    const have = byTitle[r.titleId];
    if (!have || (kinds.get(have) !== "tmdb" && kinds.get(r.collectionId) === "tmdb")) byTitle[r.titleId] = r.collectionId;
  }
  return { cards: Object.fromEntries(cards.map((c) => [c.id, c])), byTitle };
}
