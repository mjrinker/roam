/** Hand-made collections: an admin makes one in a library, names it, and puts titles in it. (A film series follows TMDB and isn't edited.) */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { collectionItems, collections, titles } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const COLLECTION_NAME_MAX = 80;
const KINDS = ["movie", "show", "audiobook"] as const;

export const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= COLLECTION_NAME_MAX ? name : null;
};

export async function createCollection(ex: Db, args: { libraryId: string; name: string }): Promise<{ id: string } | "taken"> {
  const dup = await ex.select({ id: collections.id }).from(collections).where(and(eq(collections.libraryId, args.libraryId), sql`lower(${collections.name}) = lower(${args.name})`)).limit(1);
  if (dup.length) return "taken";
  const [row] = await ex.insert(collections).values({ libraryId: args.libraryId, name: args.name, kind: "manual" }).returning({ id: collections.id });
  return row;
}

/** Only a hand-made collection can be changed. Returns false when it isn't one (or doesn't exist). */
async function manual(ex: Db, id: string) {
  const [c] = await ex.select({ id: collections.id, libraryId: collections.libraryId, kind: collections.kind }).from(collections).where(eq(collections.id, id)).limit(1);
  return c && c.kind === "manual" ? c : null;
}

export async function renameCollection(ex: Db, id: string, name: string): Promise<"ok" | "taken" | "not_found"> {
  const c = await manual(ex, id);
  if (!c) return "not_found";
  const dup = await ex.select({ id: collections.id }).from(collections).where(and(eq(collections.libraryId, c.libraryId), sql`lower(${collections.name}) = lower(${name})`, sql`${collections.id} <> ${id}`)).limit(1);
  if (dup.length) return "taken";
  await ex.update(collections).set({ name }).where(eq(collections.id, id));
  return "ok";
}

export async function deleteCollection(ex: Db, id: string): Promise<boolean> {
  if (!(await manual(ex, id))) return false;
  await ex.delete(collections).where(eq(collections.id, id));
  return true;
}

/** Puts titles of the collection's own library in it, after the ones already there. Returns how many were added, or null when it isn't a hand-made collection. */
export async function addToCollection(ex: Db, id: string, titleIds: string[]): Promise<number | null> {
  const c = await manual(ex, id);
  if (!c) return null;
  const valid = await ex.select({ id: titles.id }).from(titles).where(and(eq(titles.libraryId, c.libraryId), inArray(titles.id, titleIds), inArray(titles.kind, [...KINDS])));
  if (valid.length === 0) return 0;
  // In the order they were asked for (the database may answer in any order).
  valid.sort((x, y) => titleIds.indexOf(x.id) - titleIds.indexOf(y.id));
  const [{ top }] = await ex.select({ top: sql<number>`coalesce(max(${collectionItems.position}), -1)::int` }).from(collectionItems).where(eq(collectionItems.collectionId, id));
  const rows = await ex
    .insert(collectionItems)
    .values(valid.map((t, i) => ({ collectionId: id, titleId: t.id, position: top + 1 + i })))
    .onConflictDoNothing()
    .returning({ titleId: collectionItems.titleId });
  return rows.length;
}

export async function removeFromCollection(ex: Db, id: string, titleId: string): Promise<boolean> {
  if (!(await manual(ex, id))) return false;
  await ex.delete(collectionItems).where(and(eq(collectionItems.collectionId, id), eq(collectionItems.titleId, titleId)));
  return true;
}

/** The hand-made collections of a library by name, with whether `titleId` is in each. */
export async function manualCollections(ex: Db, libraryId: string, titleId: string | null): Promise<{ id: string; name: string; has: boolean }[]> {
  const rows = await ex
    .select({ id: collections.id, name: collections.name, has: titleId ? sql<boolean>`EXISTS (SELECT 1 FROM collection_items i WHERE i.collection_id = ${collections.id} AND i.title_id = ${titleId})` : sql<boolean>`false` })
    .from(collections)
    .where(and(eq(collections.libraryId, libraryId), eq(collections.kind, "manual")))
    .orderBy(sql`lower(${collections.name})`);
  return rows.map((r) => ({ ...r, has: r.has === true }));
}
