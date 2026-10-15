/** LRCLIB (lrclib.net): a free lyrics service that asks for no key, only for callers to say who they are. */
export interface LrclibResult {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

export interface Song {
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number | null;
}

const BASE = "https://lrclib.net/api";
const HEADERS = { "User-Agent": "Roam (https://github.com/mjrinker/roam)", Accept: "application/json" };
const MAX_CHARS = 100_000;

interface Raw {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.slice(0, MAX_CHARS) : null);
const shape = (r: Raw): LrclibResult => ({ synced: clean(r.syncedLyrics), plain: clean(r.plainLyrics), instrumental: r.instrumental === true });

async function getJson(url: string, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
  return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
}

/**
 * The lyrics for a song: the exact match first (title, artist, album and length), else the best of a search by title and artist: one whose length is
 * within three seconds, preferring one with timed lines. Null when LRCLIB has nothing; throws when it can't be reached.
 */
export async function findLyrics(song: Song, fetchImpl: typeof fetch = fetch): Promise<LrclibResult | null> {
  if (!song.title.trim() || !song.artist.trim()) return null;
  if (song.album && song.durationSeconds) {
    const q = new URLSearchParams({ track_name: song.title, artist_name: song.artist, album_name: song.album, duration: String(Math.round(song.durationSeconds)) });
    const exact = await getJson(`${BASE}/get?${q}`, fetchImpl);
    if (exact.status === 200 && exact.body && typeof exact.body === "object") return shape(exact.body as Raw);
    if (exact.status >= 500) throw new Error(`LRCLIB answered ${exact.status}`);
  }
  const q = new URLSearchParams({ track_name: song.title, artist_name: song.artist });
  const found = await getJson(`${BASE}/search?${q}`, fetchImpl);
  if (found.status >= 500) throw new Error(`LRCLIB answered ${found.status}`);
  if (found.status !== 200 || !Array.isArray(found.body)) return null;
  const near = (found.body as Raw[]).filter((r) => !song.durationSeconds || r.duration === undefined || Math.abs(r.duration - (song.durationSeconds as number)) <= 3);
  const best = near.find((r) => clean(r.syncedLyrics)) ?? near.find((r) => clean(r.plainLyrics)) ?? near.find((r) => r.instrumental === true);
  return best ? shape(best) : null;
}
