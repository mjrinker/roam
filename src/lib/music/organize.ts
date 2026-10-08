/**
 * Groups a music library's tracks into artists and albums. Run after a scan has read the files' tags; safe to run
 * any number of times: it only writes what differs. A track's place comes from its folders (see placement.ts), so
 * moving a file between folders in Box moves it between albums on the next scan.
 *
 * The app has ONE database connection: each chunk is a single transaction that uses only `tx`.
 */
import { and, asc, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { artistSortKey, nameKey, placeTrack } from "@/lib/music/placement";

const CHUNK = 500;
const tidy = (name: string) => name.trim().replace(/\s+/g, " ");

export interface OrganizeResult {
  /** Tracks whose album, track number or disc was set or changed. */
  placed: number;
  /** False if the time ran out first: the caller should run another pass (what was done is kept). */
  complete: boolean;
}

/**
 * Two passes grouping one library at once (or a prune sweeping while a pass fills an artist) could delete a group the other is
 * about to use, so every write here first takes this library's lock for the length of its transaction.
 */
export const lockMusicLibrary = (tx: Pick<typeof db, "execute">, libraryId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"music:" + libraryId}))`);

/** Removes albums with no tracks, then artists with no albums, in one library (after tracks leave Box or move). */
export async function sweepEmptyMusicGroups(libraryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockMusicLibrary(tx, libraryId);
    await tx
      .delete(musicAlbums)
      .where(
        and(
          eq(musicAlbums.libraryId, libraryId),
          notExists(tx.select({ one: sql`1` }).from(titles).where(eq(titles.albumId, musicAlbums.id)))
        )
      );
    await tx
      .delete(musicArtists)
      .where(
        and(
          eq(musicArtists.libraryId, libraryId),
          notExists(tx.select({ one: sql`1` }).from(musicAlbums).where(eq(musicAlbums.artistId, musicArtists.id)))
        )
      );
  });
}

export async function organizeMusicLibrary(libraryId: string, deadline = Infinity): Promise<OrganizeResult> {
  let after = "00000000-0000-0000-0000-000000000000";
  let placed = 0;
  const artistIds = new Map<string, string>(); // artist key -> id
  const albumIds = new Map<string, string>(); // artist key + "\0" + album key -> id

  while (true) {
    if (Date.now() > deadline) return { placed, complete: false };
    const rows = await db
      .select({
        id: titles.id,
        folderPath: titles.folderPath,
        fileName: mediaFiles.filename,
        tagArtist: titles.authors,
        albumId: titles.albumId,
        trackNumber: titles.trackNumber,
        discNumber: titles.discNumber,
      })
      .from(titles)
      .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
      .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "audiobook"), isNotNull(titles.folderPath), gt(titles.id, after)))
      .orderBy(asc(titles.id))
      .limit(CHUNK);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const placements = rows.map((r) => ({ row: r, p: placeTrack({ folderPath: r.folderPath ?? "", fileName: r.fileName, tagArtist: r.tagArtist?.[0] ?? null }) }));

    placed += await db.transaction(async (tx) => {
      await lockMusicLibrary(tx, libraryId);
      // Another pass may have removed groups we resolved in an earlier chunk (an empty-group sweep): start each chunk from the database.
      artistIds.clear();
      albumIds.clear();
      // Artists and albums this chunk needs that we haven't resolved yet. The no-op update makes RETURNING include rows that already existed.
      const newArtists = new Map<string, string>();
      for (const { p } of placements) {
        const key = nameKey(p.artist);
        // Several spellings in one chunk: the same one every run (capitals sort first, so "The Beatles" beats "the beatles").
        const shown = tidy(p.artist);
        if (!artistIds.has(key) && (!newArtists.has(key) || shown < newArtists.get(key)!)) newArtists.set(key, shown);
      }
      if (newArtists.size > 0) {
        const inserted = await tx
          .insert(musicArtists)
          .values([...newArtists].map(([key, name]) => ({ libraryId, name, nameKey: key, sortKey: artistSortKey(name) })))
          .onConflictDoUpdate({ target: [musicArtists.libraryId, musicArtists.nameKey], set: { nameKey: sql`excluded.name_key` } })
          .returning({ id: musicArtists.id, key: musicArtists.nameKey });
        for (const a of inserted) artistIds.set(a.key, a.id);
      }

      const newAlbums = new Map<string, { artistId: string; name: string; key: string }>();
      for (const { p } of placements) {
        const artistId = artistIds.get(nameKey(p.artist))!;
        const mapKey = `${artistId}\0${nameKey(p.album)}`;
        const shown = tidy(p.album);
        if (!albumIds.has(mapKey) && (!newAlbums.has(mapKey) || shown < newAlbums.get(mapKey)!.name)) newAlbums.set(mapKey, { artistId, name: shown, key: nameKey(p.album) });
      }
      if (newAlbums.size > 0) {
        const inserted = await tx
          .insert(musicAlbums)
          .values([...newAlbums.values()].map((a) => ({ libraryId, artistId: a.artistId, name: a.name, nameKey: a.key })))
          .onConflictDoUpdate({ target: [musicAlbums.artistId, musicAlbums.nameKey], set: { nameKey: sql`excluded.name_key` } })
          .returning({ id: musicAlbums.id, artistId: musicAlbums.artistId, key: musicAlbums.nameKey });
        for (const a of inserted) albumIds.set(`${a.artistId}\0${a.key}`, a.id);
      }

      const changed = placements
        .map(({ row, p }) => ({ row, albumId: albumIds.get(`${artistIds.get(nameKey(p.artist))}\0${nameKey(p.album)}`)!, track: p.track, disc: p.disc }))
        .filter((c) => c.row.albumId !== c.albumId || c.row.trackNumber !== c.track || c.row.discNumber !== c.disc);
      if (changed.length > 0) {
        const values = changed.map((c) => sql`(${c.row.id}::uuid, ${c.albumId}::uuid, ${c.track}::int, ${c.disc}::int)`);
        await tx.execute(sql`
          UPDATE titles t SET album_id = v.album_id, track_number = v.track, disc_number = v.disc
          FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, album_id, track, disc)
          WHERE t.id = v.id AND t.library_id = ${libraryId}`);
      }
      return changed.length;
    });
  }

  // An album's year is the earliest year its tracks' tags give.
  await db.execute(sql`
    UPDATE music_albums a SET year = y.year
    FROM (SELECT album_id, min(year) AS year FROM titles WHERE library_id = ${libraryId} AND album_id IS NOT NULL GROUP BY album_id) y
    WHERE a.id = y.album_id AND a.library_id = ${libraryId} AND a.match_status <> 'matched' AND a.year IS DISTINCT FROM y.year`);
  await sweepEmptyMusicGroups(libraryId);
  return { placed, complete: true };
}
