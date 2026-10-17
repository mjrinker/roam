/**
 * Radio from an artist or a song: a list of songs from the library that sounds like it. It plays the seed artist often, and otherwise the
 * artists most like it that are in the library (from the same ListenBrainz data as "Similar artists"); when too few of those are here it fills
 * out with the rest of the library. Never the same artist twice in a row while there is a choice. The building is pure (given who is in the pool
 * and a source of randomness) so it is tested apart from the database.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { artistAboutFor, type AboutDeps } from "@/lib/music/about";
import { artistSongIds, listArtists, type Scope } from "@/lib/music/browse";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** How many songs a radio holds. */
export const RADIO_LENGTH = 100;
/** The share of the songs that are the seed artist's own. */
export const SEED_SHARE = 0.3;
/** With fewer similar artists than this in the library, the rest of the library fills in. */
export const MIN_SIMILAR_ARTISTS = 4;
const MAX_SIMILAR_ARTISTS = 12;
const SONGS_PER_ARTIST = 40;

export interface RadioArtist {
  id: string;
  /** Its songs this viewer may hear. */
  songs: string[];
  /** How much it is played: the seed's is set by SEED_SHARE; the others by how alike they are. */
  weight: number;
}

/**
 * Picks `length` songs: repeatedly an artist by weight (not the one just played, when another is left), then one of its songs not yet used.
 * A song given as `firstSongId` starts it. Stops when every song is used.
 */
export function buildRadio(args: { artists: RadioArtist[]; length?: number; firstSongId?: string; random?: () => number }): string[] {
  const random = args.random ?? Math.random;
  const length = args.length ?? RADIO_LENGTH;
  const pool = args.artists.filter((a) => a.songs.length > 0 && a.weight > 0).map((a) => ({ id: a.id, weight: a.weight, left: [...new Set(a.songs)] }));
  const out: string[] = [];
  let last: string | null = null;

  const take = (artist: (typeof pool)[number], songId?: string) => {
    const at = songId ? artist.left.indexOf(songId) : Math.floor(random() * artist.left.length);
    if (at < 0) return false;
    out.push(artist.left.splice(at, 1)[0]);
    last = artist.id;
    return true;
  };

  if (args.firstSongId) {
    for (const a of pool) if (take(a, args.firstSongId)) break;
  }
  while (out.length < length) {
    const live = pool.filter((a) => a.left.length > 0);
    if (live.length === 0) break;
    const choices = live.length > 1 ? live.filter((a) => a.id !== last) : live;
    const total = choices.reduce((n, a) => n + a.weight, 0);
    let ticket = random() * total;
    const chosen = choices.find((a) => (ticket -= a.weight) < 0) ?? choices[choices.length - 1];
    take(chosen);
  }
  return out;
}

/** How alike a similar artist is by rank (they arrive best first): the closest counts most, and none is ever dropped to nothing. */
export function similarWeight(rank: number): number {
  return 1 / Math.sqrt(rank + 1);
}

/** Weights for the seed and the others so that the seed gets SEED_SHARE of the plays (when there are others), the others sharing the rest by `others`' own weights. */
export function shareWeights(seed: number, others: number[]): { seed: number; others: number[] } {
  const sum = others.reduce((n, w) => n + w, 0);
  if (others.length === 0 || sum <= 0) return { seed, others: [] };
  return { seed: SEED_SHARE, others: others.map((w) => ((1 - SEED_SHARE) * w) / sum) };
}

export interface Radio {
  /** The songs, in the order to play. */
  ids: string[];
  /** Whom it is from, for a toast or a title. */
  artistName: string;
  /** How many other artists make it up. */
  fromArtists: number;
}

/**
 * The radio for an artist (or the artist of a song, which then plays first). Null when the seed isn't something this viewer can see, or the
 * library has nothing to play. `deps` is for tests.
 */
export async function radioFor(ex: Db, scope: Scope, seed: { artistId: string; songId?: string }, deps: AboutDeps = {}): Promise<Radio | null> {
  const [artist] = await ex.select({ id: musicArtists.id, name: musicArtists.name, libraryId: musicArtists.libraryId }).from(musicArtists).where(eq(musicArtists.id, seed.artistId));
  if (!artist) return null;
  const own = await artistSongIds(ex, { ...scope, artistId: artist.id }, 400);
  if (!own || own.length === 0) return null;
  if (seed.songId && !own.includes(seed.songId)) return null;

  // The artists most like this one that are in the library (the lookup may be off, or find nothing).
  const about = await artistAboutFor(ex, scope, artist.id, deps).catch(() => null);
  const similar = (about?.similarInLibrary ?? []).slice(0, MAX_SIMILAR_ARTISTS);
  let others = similar.map((a, rank) => ({ id: a.id, weight: similarWeight(rank) }));
  if (others.length < MIN_SIMILAR_ARTISTS) {
    // Too few alike: bring in the rest of the library, played less than the ones that are alike.
    const everyone = await listArtists(ex, { ...scope, libraryId: artist.libraryId, limit: 500 });
    const have = new Set([artist.id, ...others.map((o) => o.id)]);
    const filler = (everyone?.items ?? []).filter((a) => !have.has(a.id));
    others = [...others, ...filler.map((a) => ({ id: a.id, weight: 0.15 }))];
  }
  const weights = shareWeights(1, others.map((o) => o.weight));
  const pool: RadioArtist[] = [{ id: artist.id, songs: own, weight: weights.seed }];
  for (const [i, o] of others.entries()) {
    const songs = await artistSongIds(ex, { ...scope, artistId: o.id }, SONGS_PER_ARTIST);
    if (songs?.length) pool.push({ id: o.id, songs, weight: weights.others[i] });
  }
  const ids = buildRadio({ artists: pool, firstSongId: seed.songId });
  return ids.length ? { ids, artistName: artist.name, fromArtists: pool.length - 1 } : null;
}

/** The artist a song belongs to, for starting a radio from a song (null for anything that isn't a song in a music library). */
export async function artistOfSong(ex: Db, songId: string): Promise<string | null> {
  const [row] = await ex
    .select({ artistId: musicAlbums.artistId })
    .from(titles)
    .innerJoin(musicAlbums, eq(musicAlbums.id, titles.albumId))
    .where(and(eq(titles.id, songId), eq(titles.kind, "audiobook")));
  return row?.artistId ?? null;
}
