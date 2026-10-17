/** Reading a profile's labels on one server: only titles it may still see (library access, age limit, something to play). */
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { labelItems, labels, libraries, titles } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { hasPlayableFile } from "@/lib/content/playable";
import { LABEL_TITLE_KINDS } from "./kinds";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Scope = { actor: LibraryActor; viewer: AccessProfile; viewerId: string; serverId: string };

const visibleTitle = (ex: Db, s: Scope) => and(eq(libraries.serverId, s.serverId), libraryVisible(ex, s.actor), contentFilter(s.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind));

/** The profile's labels with how many titles on this server (that it can see) each has, A to Z. */
export async function visibleLabels(ex: Db, s: Scope): Promise<{ id: string; name: string; count: number }[]> {
  const mine = await ex.select({ id: labels.id, name: labels.name }).from(labels).where(eq(labels.viewerId, s.viewerId)).orderBy(asc(labels.nameKey));
  const rows = await ex
    .select({ labelId: labelItems.labelId, n: sql<number>`count(*)::int` })
    .from(labelItems)
    .innerJoin(labels, eq(labels.id, labelItems.labelId))
    .innerJoin(titles, eq(titles.id, labelItems.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(labels.viewerId, s.viewerId), visibleTitle(ex, s)))
    .groupBy(labelItems.labelId);
  const counts = new Map(rows.map((r) => [r.labelId, r.n]));
  return mine.map((l) => ({ id: l.id, name: l.name, count: counts.get(l.id) ?? 0 }));
}

export interface LabelledTitle {
  id: string;
  kind: "movie" | "show" | "audiobook" | "ebook";
  name: string;
  year: number | null;
  posterUrl: string | null;
}

/** One of the profile's labels with its titles on this server that it can see (newest labelled first); null when the label isn't the profile's. */
export async function labelWithTitles(ex: Db, s: Scope, labelId: string): Promise<{ id: string; name: string; titles: LabelledTitle[] } | null> {
  const [label] = await ex.select({ id: labels.id, name: labels.name }).from(labels).where(and(eq(labels.id, labelId), eq(labels.viewerId, s.viewerId)));
  if (!label) return null;
  const rows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl })
    .from(labelItems)
    .innerJoin(titles, eq(titles.id, labelItems.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(labelItems.labelId, label.id), visibleTitle(ex, s)))
    .orderBy(sql`lower(${titles.name})`);
  return { ...label, titles: rows.filter((r): r is typeof r & { kind: LabelledTitle["kind"] } => (LABEL_TITLE_KINDS as readonly string[]).includes(r.kind)) };
}
