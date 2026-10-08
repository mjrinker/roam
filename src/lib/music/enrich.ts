/**
 * Matches a music library's albums against MusicBrainz and the Cover Art Archive. For each album that hasn't been tried
 * (or whose number of tracks has changed since): find the release, and when it clearly is this album, take its name and
 * year, its artist's id, its track titles (for songs whose title came only from the file name) and its front cover (for
 * songs with no cover of their own). Nothing the owner or the files said is ever replaced by a guess: a song with a title
 * tag keeps it, a song with an embedded cover keeps it, and an album with no clear match keeps its folder names.
 *
 * Time-bounded and retry-capped like the other metadata passes: a few tries per album, then it is left as it is.
 */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { musicAlbums, musicArtists, titleArtwork, titles } from "@/lib/db/schema";
import { createMusicBrainz, mapTracks, pickRelease, yearOfDate, sameArtist, type MusicBrainzClient } from "@/lib/music/musicbrainz";
import { storeArtwork } from "@/lib/scan/artwork-store";

export const MAX_MATCH_ATTEMPTS = 3;
// Albums tried per pass: a pass is also doing other work, and MusicBrainz allows one request a second.
const ALBUMS_PER_PASS = 25;
/** A failed try waits this long before the next (MusicBrainz may simply be down). */
const RETRY_AFTER_MS = 30 * 60 * 1000;

let shared: MusicBrainzClient | null = null;
const defaultClient = () => (shared ??= createMusicBrainz());

/** Turns online matching off for one library without touching the others: see the library's `musicLookup` setting. */
export interface EnrichDeps {
  client?: MusicBrainzClient;
  now?: () => Date;
}

export async function enrichMusicLibrary(libraryId: string, deadline: number, errors: string[], deps: EnrichDeps = {}): Promise<boolean> {
  const client = deps.client ?? defaultClient();
  const now = deps.now ?? (() => new Date());
  const retryBefore = new Date(now().getTime() - RETRY_AFTER_MS);

  const trackCount = sql<number>`(SELECT count(*)::int FROM titles t WHERE t.album_id = ${musicAlbums.id})`;
  const due = await db
    .select({ id: musicAlbums.id, name: musicAlbums.name, artistId: musicAlbums.artistId, artist: musicArtists.name, attempts: musicAlbums.matchAttempts, mbid: musicAlbums.mbid, tracks: trackCount })
    .from(musicAlbums)
    .innerJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
    .where(
      and(
        eq(musicAlbums.libraryId, libraryId),
        or(
          and(eq(musicAlbums.matchStatus, "pending"), lt(musicAlbums.matchAttempts, MAX_MATCH_ATTEMPTS), or(isNull(musicAlbums.matchAttemptedAt), lt(musicAlbums.matchAttemptedAt, retryBefore))),
          // Matched, but files have since been added or removed.
          and(eq(musicAlbums.matchStatus, "matched"), sql`${musicAlbums.matchedTrackCount} IS DISTINCT FROM ${trackCount}`)
        )
      )
    )
    .orderBy(asc(musicAlbums.id))
    .limit(ALBUMS_PER_PASS + 1);
  let incomplete = due.length > ALBUMS_PER_PASS;

  for (const album of due.slice(0, ALBUMS_PER_PASS)) {
    if (Date.now() > deadline) return true;
    if (album.tracks === 0) continue; // about to be swept
    try {
      await matchAlbum(client, album, now());
    } catch (err) {
      incomplete = true;
      errors.push(`music lookup ${album.artist} / ${album.name}: ${(err as Error).message}`);
      // Counted so an album that always fails stops being tried; the wait before the next try is the retry gap.
      await db
        .update(musicAlbums)
        .set({ matchAttempts: sql`${musicAlbums.matchAttempts} + 1`, matchAttemptedAt: now(), ...(album.attempts + 1 >= MAX_MATCH_ATTEMPTS ? { matchStatus: "unmatched" as const } : {}) })
        .where(eq(musicAlbums.id, album.id));
    }
  }
  return incomplete;
}

async function matchAlbum(
  client: MusicBrainzClient,
  album: { id: string; name: string; artistId: string; artist: string; mbid: string | null; tracks: number },
  at: Date
): Promise<void> {
  const tracks = await db
    .select({ id: titles.id, disc: titles.discNumber, track: titles.trackNumber, name: titles.name, nameSource: titles.nameSource })
    .from(titles)
    .where(eq(titles.albumId, album.id));
  // No clear match this time. An album that was matched before (a song was added or removed since) keeps what it has and is not asked about again until the count changes.
  const unmatched = () =>
    db
      .update(musicAlbums)
      .set(
        album.mbid
          ? { matchedTrackCount: tracks.length, matchAttemptedAt: at }
          : { matchStatus: "unmatched", matchAttempts: sql`${musicAlbums.matchAttempts} + 1`, matchAttemptedAt: at }
      )
      .where(eq(musicAlbums.id, album.id));

  const candidates = await client.searchReleases(album.artist, album.name);
  const pick = pickRelease(candidates, { artist: album.artist, album: album.name, trackCount: tracks.length });
  if (!pick) return void (await unmatched());
  const release = await client.getRelease(pick.id);
  if (!release) return void (await unmatched());

  const mapped = mapTracks(tracks.map((t) => ({ id: t.id, disc: t.disc, track: t.track, name: t.name })), release.tracks);
  // Songs with no picture of their own get the release's cover (fetched once, before the write).
  const withArt = new Set(
    (await db.select({ id: titleArtwork.titleId }).from(titleArtwork).innerJoin(titles, eq(titles.id, titleArtwork.titleId)).where(eq(titles.albumId, album.id))).map((r) => r.id)
  );
  const needCover = tracks.filter((t) => !withArt.has(t.id));
  const cover = needCover.length > 0 ? await client.getFrontCover(release.id).catch(() => null) : null;

  await db.transaction(async (tx) => {
    await tx
      .update(musicAlbums)
      .set({
        name: release.title,
        year: yearOfDate(release.date) ?? undefined,
        mbid: release.id,
        matchStatus: "matched",
        matchAttempts: sql`${musicAlbums.matchAttempts} + 1`,
        matchAttemptedAt: at,
        matchedTrackCount: tracks.length,
      })
      .where(eq(musicAlbums.id, album.id));
    if (release.artistId && sameArtist(album.artist, release.artist)) {
      await tx.update(musicArtists).set({ mbid: release.artistId }).where(eq(musicArtists.id, album.artistId));
    }
    for (const t of tracks) {
      const r = mapped.get(t.id);
      // A title from the file's own tags is the owner's; only a name that came from the file name is replaced.
      if (r && t.nameSource === "filename" && r.title !== t.name) {
        await tx.update(titles).set({ name: r.title, nameSource: "online" }).where(and(eq(titles.id, t.id), eq(titles.nameSource, "filename")));
      }
    }
    if (cover) for (const t of needCover) await storeArtwork(tx, t.id, cover, "online");
  });
}
