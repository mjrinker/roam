/**
 * Who is credited on audiobooks: authors and narrators (a full-cast recording lists many). They are plain names, not ids, so two
 * spellings that differ only in case or spacing are the same person. Used by the book page, the Authors view and a contributor's page.
 */
import { and, asc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, titles } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The name as compared: trimmed, lower case, single spaces. */
export const personKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

interface CreditFields {
  authors: string[] | null;
  narrators: string[] | null;
  folderAuthor: string | null;
}

const distinct = (names: (string | null | undefined)[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const clean = n?.trim().replace(/\s+/g, " ");
    if (!clean || seen.has(personKey(clean))) continue;
    seen.add(personKey(clean));
    out.push(clean);
  }
  return out;
};

/** A book's authors (the folder it was found under when no author is known) and its narrators, each person once. */
export function bookCredits(book: CreditFields): { authors: string[]; narrators: string[] } {
  const authors = distinct(book.authors?.length ? book.authors : [book.folderAuthor]);
  return { authors, narrators: distinct(book.narrators ?? []) };
}

export const contributorHref = (serverId: string, name: string): string => `/s/${serverId}/contributor/${encodeURIComponent(name)}`;

export interface AuthorTile {
  key: string;
  name: string;
  books: number;
  coverUrl: string | null;
}

/** The authors of a set of books, A to Z, each with how many books and a cover to show. */
export function groupAuthors(books: (CreditFields & { posterUrl: string | null })[]): AuthorTile[] {
  const tiles = new Map<string, AuthorTile>();
  for (const book of books) {
    for (const name of bookCredits(book).authors) {
      const key = personKey(name);
      const tile = tiles.get(key) ?? { key, name, books: 0, coverUrl: null };
      tile.books++;
      tile.coverUrl ??= book.posterUrl;
      tiles.set(key, tile);
    }
  }
  return [...tiles.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
}

const KEYED = (value: SQL) => sql`regexp_replace(lower(btrim(${value})), '\\s+', ' ', 'g')`;
/** True when the jsonb array column (or a non-array, as nothing) has this person among its elements. */
const inList = (column: SQLWrapper, key: string): SQL =>
  sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${column}) = 'array' then ${column} else '[]'::jsonb end) as e(v) where ${KEYED(sql`e.v`)} = ${key})`;

export interface ContributorBook {
  id: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  seriesName: string | null;
  seriesPosition: string | null;
}

export interface Contributor {
  name: string;
  written: ContributorBook[];
  narrated: ContributorBook[];
}

/** Everything on this server a person is credited with, as author and as narrator, or null when there is nothing the viewer can see. */
export async function loadContributor(ex: Db, actor: LibraryActor, viewer: AccessProfile, name: string): Promise<Contributor | null> {
  const key = personKey(name);
  if (!key) return null;
  const folderMatch = sql`(coalesce(jsonb_array_length(case when jsonb_typeof(${titles.authors}) = 'array' then ${titles.authors} else '[]'::jsonb end), 0) = 0 and ${KEYED(sql`coalesce(${titles.folderAuthor}, '')`)} = ${key})`;
  const rows = await ex
    .select({
      id: titles.id,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
      seriesName: titles.seriesName,
      seriesPosition: titles.seriesPosition,
      authors: titles.authors,
      narrators: titles.narrators,
      folderAuthor: titles.folderAuthor,
    })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.kind, "audiobook"), eq(libraries.kind, "audiobooks"), libraryVisible(ex, actor), contentFilter(viewer, titles.ratingAges), sql`(${inList(titles.authors, key)} or ${folderMatch} or ${inList(titles.narrators, key)})`))
    .orderBy(asc(titles.seriesName), asc(titles.seriesPosition), asc(titles.name), asc(titles.id));
  if (rows.length === 0) return null;
  const written: ContributorBook[] = [];
  const narrated: ContributorBook[] = [];
  const spellings = new Map<string, number>();
  for (const r of rows) {
    const credits = bookCredits(r);
    const book = { id: r.id, name: r.name, year: r.year, posterUrl: r.posterUrl, seriesName: r.seriesName, seriesPosition: r.seriesPosition };
    const asAuthor = credits.authors.find((n) => personKey(n) === key);
    const asNarrator = credits.narrators.find((n) => personKey(n) === key);
    if (asAuthor) written.push(book);
    if (asNarrator) narrated.push(book);
    for (const n of [asAuthor, asNarrator]) if (n) spellings.set(n, (spellings.get(n) ?? 0) + 1);
  }
  // Shown as most books spell it; on a tie, one with proper capitals rather than all lower or all upper case.
  const proper = (n: string) => n !== n.toLowerCase() && n !== n.toUpperCase();
  const [display] = [...spellings.entries()].sort(([a, x], [b, y]) => y - x || Number(proper(b)) - Number(proper(a)) || a.localeCompare(b))[0] ?? [name.trim()];
  return { name: display, written, narrated };
}
