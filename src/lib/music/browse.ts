/**
 * Reading a music library as Artists, Albums and Songs. Every query starts from the TRACKS a viewer may see
 * (library access and age limit applied before anything is counted or grouped), so an album or artist whose
 * songs are all hidden never appears and neither do its name, count or cover.
 */
import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { libraries, mediaFiles, musicAlbums, musicArtists, titles } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface Scope {
  actor: LibraryActor;
  viewer: AccessProfile;
}

export interface ArtistCard {
  id: string;
  name: string;
  albumCount: number;
  trackCount: number;
  /** Up to four album covers, for the artist's tile. */
  coverUrls: string[];
}

export interface AlbumCard {
  id: string;
  name: string;
  year: number | null;
  artistId: string;
  artistName: string;
  trackCount: number;
  coverUrl: string | null;
  matched: boolean;
}

export interface TrackRow {
  id: string;
  name: string;
  discNumber: number | null;
  trackNumber: number | null;
  durationSeconds: number | null;
  /** The artist named in the song's own tags, when it differs from the album's artist. */
  artist: string | null;
}

export interface AlbumPage {
  album: AlbumCard & { libraryId: string; libraryName: string };
  tracks: TrackRow[];
  totalSeconds: number;
}

export interface Cursor {
  key: string;
  id: string;
}

const PAGE = 120;
const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? PAGE, 1), 500);

/** SQL: a track in `albumCol`'s album that this viewer may see. */
function visibleTrackOf(scope: Scope, albumId: SQL | typeof musicAlbums.id): SQL {
  return sql`SELECT 1 FROM titles vt WHERE vt.album_id = ${albumId} AND vt.kind = 'audiobook' AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`}`;
}

const trackCountOf = (scope: Scope, albumId: typeof musicAlbums.id) =>
  sql<number>`(SELECT count(*)::int FROM titles vt WHERE vt.album_id = ${albumId} AND vt.kind = 'audiobook' AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`})`;

/** The album's picture: the first visible song that has one, in album order. */
const coverOf = (scope: Scope, albumId: typeof musicAlbums.id) =>
  sql<string | null>`(SELECT vt.poster_url FROM titles vt WHERE vt.album_id = ${albumId} AND vt.kind = 'audiobook' AND vt.poster_url IS NOT NULL AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`} ORDER BY vt.disc_number NULLS LAST, vt.track_number NULLS LAST, vt.sort_key, vt.id LIMIT 1)`;

const inMusicLibrary = (ex: Db, scope: Scope, libraryId?: string): SQL =>
  and(eq(libraries.kind, "music"), libraryVisible(ex, scope.actor), libraryId ? eq(libraries.id, libraryId) : undefined) as SQL;

/** One page of a library's artists, by name. Null when the library isn't a music library this viewer can see. */
export async function listArtists(ex: Db, scope: Scope & { libraryId: string; limit?: number; after?: Cursor | null }): Promise<{ items: ArtistCard[]; next: Cursor | null } | null> {
  const limit = clampLimit(scope.limit);
  const [library] = await ex.select({ id: libraries.id }).from(libraries).where(and(eq(libraries.id, scope.libraryId), inMusicLibrary(ex, scope)));
  if (!library) return null;

  const after = scope.after ? or(gt(musicArtists.sortKey, scope.after.key), and(eq(musicArtists.sortKey, scope.after.key), gt(musicArtists.id, scope.after.id))) : undefined;
  const rows = await ex
    .select({
      id: musicArtists.id,
      name: musicArtists.name,
      sortKey: musicArtists.sortKey,
      albumCount: sql<number>`(SELECT count(*)::int FROM music_albums al WHERE al.artist_id = music_artists.id AND EXISTS (${visibleTrackOf(scope, sql`al.id`)}))`,
      trackCount: sql<number>`(SELECT count(*)::int FROM titles vt JOIN music_albums al ON al.id = vt.album_id WHERE al.artist_id = music_artists.id AND vt.kind = 'audiobook' AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`})`,
      covers: sql<string[]>`COALESCE((SELECT json_agg(x.url ORDER BY x.year NULLS LAST, x.name_key) FROM (SELECT c.url, c.year, c.name_key FROM (SELECT (SELECT vt.poster_url FROM titles vt WHERE vt.album_id = al.id AND vt.kind = 'audiobook' AND vt.poster_url IS NOT NULL AND ${contentFilter(scope.viewer, sql`vt.rating_ages`) ?? sql`true`} ORDER BY vt.disc_number NULLS LAST, vt.track_number NULLS LAST, vt.id LIMIT 1) AS url, al.year AS year, al.name_key AS name_key FROM music_albums al WHERE al.artist_id = music_artists.id) c WHERE c.url IS NOT NULL ORDER BY c.year NULLS LAST, c.name_key LIMIT 4) x), '[]'::json)`,
    })
    .from(musicArtists)
    .where(and(eq(musicArtists.libraryId, scope.libraryId), after, sql`EXISTS (SELECT 1 FROM music_albums al WHERE al.artist_id = music_artists.id AND EXISTS (${visibleTrackOf(scope, sql`al.id`)}))`))
    .orderBy(asc(musicArtists.sortKey), asc(musicArtists.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ id: r.id, name: r.name, albumCount: r.albumCount, trackCount: r.trackCount, coverUrls: r.covers })),
    next: rows.length > limit && last ? { key: last.sortKey, id: last.id } : null,
  };
}

const albumColumns = (scope: Scope) => ({
  id: musicAlbums.id,
  name: musicAlbums.name,
  nameKey: musicAlbums.nameKey,
  year: musicAlbums.year,
  artistId: musicArtists.id,
  artistName: musicArtists.name,
  trackCount: trackCountOf(scope, musicAlbums.id),
  coverUrl: coverOf(scope, musicAlbums.id),
  matched: sql<boolean>`${musicAlbums.matchStatus} = 'matched'`,
});

/** One page of a library's albums, by name; or, with `artistId`, that artist's albums, oldest first. */
export async function listAlbums(
  ex: Db,
  scope: Scope & { libraryId: string; artistId?: string; limit?: number; after?: Cursor | null }
): Promise<{ items: AlbumCard[]; next: Cursor | null } | null> {
  const limit = clampLimit(scope.limit);
  const [library] = await ex.select({ id: libraries.id }).from(libraries).where(and(eq(libraries.id, scope.libraryId), inMusicLibrary(ex, scope)));
  if (!library) return null;

  const after = !scope.artistId && scope.after ? or(gt(musicAlbums.nameKey, scope.after.key), and(eq(musicAlbums.nameKey, scope.after.key), gt(musicAlbums.id, scope.after.id))) : undefined;
  const rows = await ex
    .select(albumColumns(scope))
    .from(musicAlbums)
    .innerJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
    .where(
      and(
        eq(musicAlbums.libraryId, scope.libraryId),
        scope.artistId ? eq(musicAlbums.artistId, scope.artistId) : undefined,
        after,
        sql`EXISTS (${visibleTrackOf(scope, musicAlbums.id)})`
      )
    )
    .orderBy(...(scope.artistId ? [sql`${musicAlbums.year} NULLS LAST`, asc(musicAlbums.nameKey), asc(musicAlbums.id)] : [asc(musicAlbums.nameKey), asc(musicAlbums.id)]))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the paging key is not part of the card
    items: page.map(({ nameKey: _key, ...a }) => a),
    next: !scope.artistId && rows.length > limit && last ? { key: last.nameKey, id: last.id } : null,
  };
}

/** An artist and their albums. Null when the artist (or its library) isn't visible to this viewer, or has nothing visible. */
export async function getArtist(ex: Db, scope: Scope & { artistId: string }): Promise<{ artist: { id: string; name: string; libraryId: string; libraryName: string }; albums: AlbumCard[] } | null> {
  const [row] = await ex
    .select({ id: musicArtists.id, name: musicArtists.name, libraryId: libraries.id, libraryName: libraries.name })
    .from(musicArtists)
    .innerJoin(libraries, eq(libraries.id, musicArtists.libraryId))
    .where(and(eq(musicArtists.id, scope.artistId), inMusicLibrary(ex, scope)));
  if (!row) return null;
  const albums = await listAlbums(ex, { ...scope, libraryId: row.libraryId, artistId: row.id, limit: 500 });
  if (!albums || albums.items.length === 0) return null;
  return { artist: row, albums: albums.items };
}

/** An album with its songs in order. Null when the album (or its library) isn't visible to this viewer, or none of its songs are. */
export async function getAlbum(ex: Db, scope: Scope & { albumId: string }): Promise<AlbumPage | null> {
  const [row] = await ex
    .select({ ...albumColumns(scope), libraryId: libraries.id, libraryName: libraries.name })
    .from(musicAlbums)
    .innerJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
    .innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId))
    .where(and(eq(musicAlbums.id, scope.albumId), inMusicLibrary(ex, scope)));
  if (!row || row.trackCount === 0) return null;

  const tracks = await ex
    .select({
      id: titles.id,
      name: titles.name,
      discNumber: titles.discNumber,
      trackNumber: titles.trackNumber,
      durationSeconds: mediaFiles.durationSeconds,
      artist: sql<string | null>`${titles.authors}->>0`,
    })
    .from(titles)
    .leftJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(and(eq(titles.albumId, scope.albumId), eq(titles.kind, "audiobook"), contentFilter(scope.viewer, titles.ratingAges)))
    .orderBy(sql`${titles.discNumber} NULLS FIRST`, sql`${titles.trackNumber} NULLS LAST`, asc(titles.sortKey), asc(titles.id));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the paging key is not part of the card
  const { nameKey: _key, ...album } = row;
  return {
    album,
    tracks: tracks.map((t) => ({ ...t, artist: t.artist && t.artist.trim().toLowerCase() !== row.artistName.trim().toLowerCase() ? t.artist : null })),
    totalSeconds: tracks.reduce((n, t) => n + (t.durationSeconds ?? 0), 0),
  };
}
