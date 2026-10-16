/**
 * Artists that people who listen to an artist also listen to, from ListenBrainz (MetaBrainz's open listening data; free, no key, asked by
 * MusicBrainz id). Only the artist's MusicBrainz id is sent.
 */
import { MB_USER_AGENT } from "@/lib/music/musicbrainz";

type Fetch = typeof fetch;
const ENDPOINT = "https://labs.api.listenbrainz.org/similar-artists/json";
const ALGORITHM = "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30";
/** The most kept. */
export const MAX_SIMILAR = 30;

export interface SimilarArtist {
  mbid: string;
  name: string;
  score: number;
}

/** The usable entries of an answer: well-formed, not the artist itself, best first, at most `MAX_SIMILAR`. */
export function parseSimilar(data: unknown, selfMbid: string): SimilarArtist[] {
  if (!Array.isArray(data)) return [];
  const out: SimilarArtist[] = [];
  const seen = new Set<string>([selfMbid.toLowerCase()]);
  for (const row of data) {
    const r = row as { artist_mbid?: unknown; name?: unknown; score?: unknown };
    if (typeof r.artist_mbid !== "string" || typeof r.name !== "string" || !/^[0-9a-f-]{36}$/i.test(r.artist_mbid) || !r.name.trim()) continue;
    const id = r.artist_mbid.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ mbid: id, name: r.name.trim().slice(0, 200), score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_SIMILAR);
}

export interface SimilarClient {
  similarTo(mbid: string): Promise<SimilarArtist[]>;
}

export function createSimilarArtists(opts: { fetch?: Fetch; userAgent?: string } = {}): SimilarClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    async similarTo(mbid) {
      if (!/^[0-9a-f-]{36}$/i.test(mbid)) return [];
      const res = await doFetch(`${ENDPOINT}?artist_mbids=${mbid}&algorithm=${ALGORITHM}`, { headers: { "user-agent": opts.userAgent ?? MB_USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}`);
      return parseSimilar(await res.json(), mbid);
    },
  };
}
