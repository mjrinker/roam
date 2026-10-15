/** Lyrics for a song in a music or audio library: kept after the first look, "nothing found" included (looked for again after a month). */
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, musicAlbums, musicArtists, titles, trackLyrics } from "@/lib/db/schema";
import { isSongLibraryKind } from "@/lib/libraries/profile";
import { findLyrics, type LrclibResult, type Song } from "@/lib/lyrics/lrclib";
import { parseLrc, type LyricLine } from "@/lib/lyrics/lrc";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const RETRY_AFTER_MS = 30 * 86_400_000;

export interface Lyrics {
  /** Timed lines, when the lyrics have them. */
  synced: LyricLine[] | null;
  /** The words alone (always present when there are any). */
  plain: string | null;
  instrumental: boolean;
}

/** What the song is called, by whom, on what, and how long: from the library, never from the caller. Null for anything that isn't a song. */
export async function songOf(ex: Db, titleId: string): Promise<Song | null> {
  const [row] = await ex
    .select({
      kind: libraries.kind,
      name: titles.name,
      authors: titles.authors,
      folderAuthor: titles.folderAuthor,
      album: musicAlbums.name,
      artist: musicArtists.name,
      runtime: titles.runtimeSeconds,
      fileSeconds: sql<number | null>`(SELECT sum(m.duration_seconds) FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id})`,
    })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .leftJoin(musicAlbums, eq(musicAlbums.id, titles.albumId))
    .leftJoin(musicArtists, eq(musicArtists.id, musicAlbums.artistId))
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!row || !isSongLibraryKind(row.kind)) return null;
  const artist = row.artist ?? row.authors?.[0] ?? row.folderAuthor ?? "";
  const seconds = row.runtime ?? (row.fileSeconds ? Number(row.fileSeconds) : null);
  // A file's name often begins with its number ("03 - Song"): the service wants the title alone.
  const title = row.name.replace(/^\s*\d{1,3}\s*[-._)]\s*/, "").trim();
  return { title, artist, album: row.album ?? null, durationSeconds: seconds };
}

const view = (r: { synced: string | null; plain: string | null; instrumental: boolean }): Lyrics => {
  const synced = r.synced ? parseLrc(r.synced) : [];
  return { synced: synced.length > 0 ? synced : null, plain: r.plain ?? (synced.length > 0 ? synced.map((l) => l.text).join("\n") : null), instrumental: r.instrumental };
};

/** The lyrics of a song, from what is kept or LRCLIB. Null when it isn't a song, or there are none (or LRCLIB couldn't be reached and nothing is kept). */
export async function lyricsFor(ex: Db, titleId: string, opts: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<Lyrics | null> {
  const now = opts.now ?? new Date();
  const [kept] = await ex.select().from(trackLyrics).where(eq(trackLyrics.titleId, titleId)).limit(1);
  const found = kept && (kept.synced || kept.plain || kept.instrumental);
  if (kept && (found || now.getTime() - kept.fetchedAt.getTime() < RETRY_AFTER_MS)) return found ? view(kept) : null;
  const song = await songOf(ex, titleId);
  if (!song) return null;
  let result: LrclibResult | null;
  try {
    result = await findLyrics(song, opts.fetchImpl);
  } catch {
    return kept && found ? view(kept) : null; // unreachable just now: nothing is stored, so it is asked again next time
  }
  const row = { synced: result?.synced ?? null, plain: result?.plain ?? null, instrumental: result?.instrumental ?? false, fetchedAt: now };
  await ex.insert(trackLyrics).values({ titleId, ...row }).onConflictDoUpdate({ target: trackLyrics.titleId, set: row });
  return result && (row.synced || row.plain || row.instrumental) ? view(row) : null;
}

