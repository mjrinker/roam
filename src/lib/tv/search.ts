/** Searching from a TV: the same rules as the web search box (sharing, age limit), over the libraries the TV can show, plus albums and artists. */
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter } from "@/lib/content/access";
import { libraryVisible } from "@/lib/content/library-access";
import { libraries, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { GLOBALLY_LISTED_LIBRARY_KINDS, isMusicLibraryKind, tvBrowseStyle } from "@/lib/libraries/profile";
import { titleHref, type TvScope } from "@/lib/tv/data";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const SEARCH_MAX = 40;
const TITLE_LIMIT = 18;
const ALBUM_LIMIT = 8;

export interface SearchHit {
  /** Where it opens, relative to the TV's base path. */
  href: string;
  name: string;
  meta: string | null;
  posterUrl: string | null;
  square: boolean;
}

/** What was typed, made safe to search for: trimmed, one space at most between words, at most SEARCH_MAX characters; "" when nothing is left. */
export const cleanQuery = (raw: string | null | undefined): string => (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Titles (movies, shows, audiobooks, videos, audio files) then albums (matched by album or artist name), best matches first. */
export async function tvSearch(ex: Db, scope: TvScope, rawQuery: string): Promise<SearchHit[]> {
  const q = cleanQuery(rawQuery);
  if (!q) return [];
  const pattern = `%${likeEscape(q)}%`;
  const kinds = GLOBALLY_LISTED_LIBRARY_KINDS.filter((k) => tvBrowseStyle(k) !== null && !isMusicLibraryKind(k));
  const titleRows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl, authors: titles.authors, folderAuthor: titles.folderAuthor, libraryKind: libraries.kind })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(
      and(
        inArray(libraries.kind, [...kinds]),
        inArray(titles.kind, ["movie", "show", "audiobook"]),
        libraryVisible(ex, scope.actor),
        or(ilike(titles.name, pattern), ilike(titles.folderAuthor, pattern), sql`${titles.authors}::text ilike ${pattern}`),
        contentFilter(scope.viewer, titles.ratingAges)
      )
    )
    .orderBy(desc(sql`${titles.name} ilike ${likeEscape(q) + "%"}`), asc(titles.name), asc(titles.id))
    .limit(TITLE_LIMIT);

  const trackVisible = sql`EXISTS (SELECT 1 FROM titles vt WHERE vt.album_id = ${musicAlbums.id} AND vt.kind = 'audiobook' AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`})`;
  const albumRows = await ex
    .select({
      id: musicAlbums.id,
      name: musicAlbums.name,
      year: musicAlbums.year,
      artist: musicArtists.name,
      cover: sql<string | null>`(SELECT vt.poster_url FROM titles vt WHERE vt.album_id = ${musicAlbums.id} AND vt.poster_url IS NOT NULL AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`} ORDER BY vt.disc_number NULLS LAST, vt.track_number NULLS LAST, vt.id LIMIT 1)`,
    })
    .from(musicAlbums)
    .innerJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
    .innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId))
    .where(and(inArray(libraries.kind, ["music"]), libraryVisible(ex, scope.actor), or(ilike(musicAlbums.name, pattern), ilike(musicArtists.name, pattern)), trackVisible))
    .orderBy(desc(sql`${musicAlbums.name} ilike ${likeEscape(q) + "%"} OR ${musicArtists.name} ilike ${likeEscape(q) + "%"}`), asc(musicAlbums.nameKey), asc(musicAlbums.id))
    .limit(ALBUM_LIMIT);

  return [
    ...titleRows.map((r) => ({
      href: titleHref(r.kind, r.id, r.libraryKind),
      name: r.name,
      meta: r.kind === "audiobook" ? ((r.authors ?? []).join(", ") || r.folderAuthor) : r.year ? String(r.year) : null,
      posterUrl: r.posterUrl,
      square: r.kind === "audiobook",
    })),
    ...albumRows.map((a) => ({ href: `/album/${a.id}`, name: a.name, meta: [a.artist, a.year].filter(Boolean).join(" · "), posterUrl: a.cover, square: true })),
  ];
}
