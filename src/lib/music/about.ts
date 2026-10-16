/**
 * "About" an artist or album: a short description from Wikipedia and, for an artist, the artists listeners of it also play. Looked up the first
 * time anyone opens the page and kept (a find is refreshed after a month, a miss tried again after a week). Only for libraries that have music
 * lookups turned on, and only through ids MusicBrainz gives: a name is never searched on Wikipedia, since a wrong article is worse than none.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { albumAbout, artistAbout, libraries, musicAlbums, musicArtists } from "@/lib/db/schema";
import { createMusicBrainz, sameArtistExactly, type MusicBrainzClient } from "@/lib/music/musicbrainz";
import { articleFor, createWikipedia, WIKIPEDIA_LICENSE_URL, type WikipediaClient } from "@/lib/music/wikipedia";
import { createSimilarArtists, type SimilarArtist, type SimilarClient } from "@/lib/music/similar-artists";
import { nameKey } from "@/lib/music/placement";
import { listArtists, type ArtistCard, type Scope } from "@/lib/music/browse";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const FOUND_TTL_MS = 30 * 24 * 3600_000;
export const MISSING_TTL_MS = 7 * 24 * 3600_000;
/** A search for an artist by name is only believed when MusicBrainz is this sure and the name is the very same. */
const MIN_ARTIST_SCORE = 90;

export interface AboutDeps {
  mb?: MusicBrainzClient;
  wiki?: WikipediaClient;
  similar?: SimilarClient;
  now?: () => Date;
}

export interface About {
  found: boolean;
  summary: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  licenseUrl: string;
}

export interface ArtistAbout extends About {
  /** Similar artists that are in this library, best match first. */
  similarInLibrary: ArtistCard[];
  /** Other similar artists, by name only. */
  similarElsewhere: string[];
}

const fresh = (row: { found: boolean; fetchedAt: Date }, now: Date) => now.getTime() - row.fetchedAt.getTime() < (row.found ? FOUND_TTL_MS : MISSING_TTL_MS);
const empty = (): About => ({ found: false, summary: null, sourceTitle: null, sourceUrl: null, licenseUrl: WIKIPEDIA_LICENSE_URL });

/** The MusicBrainz id for an artist: the one already known, else the one result that is plainly the same artist. */
async function artistMbid(mb: MusicBrainzClient, artist: { name: string; mbid: string | null }): Promise<string | null> {
  if (artist.mbid) return artist.mbid;
  const matches = (await mb.searchArtists(artist.name)).filter((c) => c.score >= MIN_ARTIST_SCORE && sameArtistExactly(artist.name, c.name));
  return matches.length === 1 ? matches[0].id : null; // two artists of the same name: not guessed
}

/** Similar artists as cards for those in the artist's own library, and names for the rest. */
async function placeSimilar(ex: Db, scope: Scope, artist: { id: string; libraryId: string }, similar: SimilarArtist[]): Promise<Pick<ArtistAbout, "similarInLibrary" | "similarElsewhere">> {
  if (similar.length === 0) return { similarInLibrary: [], similarElsewhere: [] };
  const keys = new Map(similar.map((s) => [nameKey(s.name), s]));
  const rows = await ex
    .select({ id: musicArtists.id, mbid: musicArtists.mbid, key: musicArtists.nameKey })
    .from(musicArtists)
    .where(and(eq(musicArtists.libraryId, artist.libraryId), or(inArray(musicArtists.mbid, similar.map((s) => s.mbid)), inArray(musicArtists.nameKey, [...keys.keys()]))));
  const byScore = new Map<string, number>(); // library artist id -> best score
  const placed = new Set<string>(); // similar mbids found in the library
  for (const r of rows) {
    if (r.id === artist.id) continue;
    const hit = similar.find((s) => s.mbid === r.mbid) ?? keys.get(r.key);
    if (!hit) continue;
    placed.add(hit.mbid);
    byScore.set(r.id, Math.max(byScore.get(r.id) ?? 0, hit.score));
  }
  const cards = byScore.size ? ((await listArtists(ex, { ...scope, libraryId: artist.libraryId, ids: [...byScore.keys()], limit: 500 }))?.items ?? []) : [];
  cards.sort((a, b) => (byScore.get(b.id) ?? 0) - (byScore.get(a.id) ?? 0));
  const inLibrary = new Set(cards.map((c) => c.id));
  const hidden = new Set(rows.filter((r) => !inLibrary.has(r.id) && r.id !== artist.id).map((r) => similar.find((s) => s.mbid === r.mbid)?.mbid ?? keys.get(r.key)?.mbid));
  return {
    similarInLibrary: cards,
    // Not in the library (or in it but hidden from this viewer, which is told nothing about).
    similarElsewhere: similar.filter((s) => !placed.has(s.mbid) && !hidden.has(s.mbid)).slice(0, 10).map((s) => s.name),
  };
}

/** About an artist, for a viewer who may see it (the caller has checked). Null when the artist's library has music lookups off, or it does not exist. */
export async function artistAboutFor(ex: Db, scope: Scope, artistId: string, deps: AboutDeps = {}): Promise<ArtistAbout | null> {
  const now = (deps.now ?? (() => new Date()))();
  const [artist] = await ex
    .select({ id: musicArtists.id, name: musicArtists.name, mbid: musicArtists.mbid, libraryId: musicArtists.libraryId, lookups: libraries.musicLookup })
    .from(musicArtists)
    .innerJoin(libraries, eq(libraries.id, musicArtists.libraryId))
    .where(eq(musicArtists.id, artistId));
  if (!artist || !artist.lookups) return null;
  const [cached] = await ex.select().from(artistAbout).where(eq(artistAbout.artistId, artistId));
  if (cached && fresh(cached, now)) {
    return { found: cached.found, summary: cached.summary, sourceTitle: cached.sourceTitle, sourceUrl: cached.sourceUrl, licenseUrl: WIKIPEDIA_LICENSE_URL, ...(await placeSimilar(ex, scope, artist, cached.similar)) };
  }

  const mb = deps.mb ?? createMusicBrainz();
  const wiki = deps.wiki ?? createWikipedia();
  const sim = deps.similar ?? createSimilarArtists();
  let summary: About = empty();
  let similar: SimilarArtist[] = [];
  let complete = true; // a network failure is not remembered as "nothing there"
  try {
    const mbid = await artistMbid(mb, artist);
    if (mbid) {
      const links = await mb.getArtistLinks(mbid);
      const article = links ? await articleFor(wiki, links).catch(() => ((complete = false), null)) : null;
      if (article) summary = { found: true, summary: article.extract, sourceTitle: article.title, sourceUrl: article.url, licenseUrl: WIKIPEDIA_LICENSE_URL };
      similar = await sim.similarTo(mbid).catch(() => ((complete = false), []));
    }
  } catch {
    complete = false;
  }
  const found = summary.found || similar.length > 0;
  if (complete) {
    const values = { found, summary: summary.summary, sourceTitle: summary.sourceTitle, sourceUrl: summary.sourceUrl, similar, fetchedAt: now };
    await ex.insert(artistAbout).values({ artistId, ...values }).onConflictDoUpdate({ target: artistAbout.artistId, set: values });
  }
  return { ...summary, found, ...(await placeSimilar(ex, scope, artist, similar)) };
}

/** About an album (only a matched one, which has a MusicBrainz release). Null when its library has music lookups off, or it does not exist. */
export async function albumAboutFor(ex: Db, albumId: string, deps: AboutDeps = {}): Promise<About | null> {
  const now = (deps.now ?? (() => new Date()))();
  const [album] = await ex
    .select({ id: musicAlbums.id, mbid: musicAlbums.mbid, lookups: libraries.musicLookup })
    .from(musicAlbums)
    .innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId))
    .where(eq(musicAlbums.id, albumId));
  if (!album || !album.lookups) return null;
  const [cached] = await ex.select().from(albumAbout).where(eq(albumAbout.albumId, albumId));
  if (cached && fresh(cached, now)) return { found: cached.found, summary: cached.summary, sourceTitle: cached.sourceTitle, sourceUrl: cached.sourceUrl, licenseUrl: WIKIPEDIA_LICENSE_URL };
  if (!album.mbid) return empty(); // not matched to a release yet: nothing to look up (not remembered, so it is tried once it is matched)

  const mb = deps.mb ?? createMusicBrainz();
  const wiki = deps.wiki ?? createWikipedia();
  let result: About = empty();
  try {
    const links = await mb.getReleaseGroupLinks(album.mbid);
    const article = links ? await articleFor(wiki, links) : null;
    if (article) result = { found: true, summary: article.extract, sourceTitle: article.title, sourceUrl: article.url, licenseUrl: WIKIPEDIA_LICENSE_URL };
  } catch {
    return empty(); // a network failure: shown as nothing now, tried again next time
  }
  const values = { found: result.found, summary: result.summary, sourceTitle: result.sourceTitle, sourceUrl: result.sourceUrl, fetchedAt: now };
  await ex.insert(albumAbout).values({ albumId, ...values }).onConflictDoUpdate({ target: albumAbout.albumId, set: values });
  return result;
}
