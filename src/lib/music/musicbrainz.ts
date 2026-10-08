/**
 * MusicBrainz (open music database, CC0 data) and the Cover Art Archive. Free, no key; the terms ask for a descriptive
 * User-Agent and at most one request a second, which `createMusicBrainz` enforces for everything that goes through it.
 * The matching rules are pure functions so they are tested without a network.
 */

export const MB_USER_AGENT = "Roam/1.0 (https://github.com/mjrinker/roam)";
const MB_API = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org";
const MIN_INTERVAL_MS = 1100;
/** No single request may take longer than this: a stalled one would hold up every lookup queued behind it. */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const COVER_HOSTS = [/^coverartarchive\.org$/, /(^|\.)archive\.org$/];

// ── Matching (pure) ──────────────────────────────────────────────────────

/** Lowercase, accents and punctuation gone, "&" read as "and", single spaces: how two spellings of a name are compared. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => new Set(normalizeName(s).split(" ").filter(Boolean));

/** Share of words two names have in common (0..1), counted against the longer one. */
export function nameSimilarity(a: string, b: string): number {
  const [x, y] = [tokens(a), tokens(b)];
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.max(x.size, y.size);
}

/** Whether a folder's artist name means this MusicBrainz artist: "Chopin" for "Frédéric Chopin", "beatles" for "The Beatles". */
export function sameArtist(folderName: string, mbName: string): boolean {
  const [a, b] = [normalizeName(folderName), normalizeName(mbName)];
  if (!a || !b) return false;
  if (a === b) return true;
  const drop = (s: string) => s.replace(/^(the|a|an) /, "");
  if (drop(a) === drop(b)) return true;
  const [x, y] = [tokens(folderName), tokens(mbName)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  // Every word of the shorter name is in the longer one, and the shorter has a real word (not just "the").
  return small.size > 0 && [...small].every((t) => big.has(t)) && [...small].some((t) => t.length > 2 && !["the", "and"].includes(t));
}

/** Like sameArtist but only for the very same name (a leading "The" aside): used before an id is attached to an artist. */
export function sameArtistExactly(folderName: string, mbName: string): boolean {
  const drop = (s: string) => normalizeName(s).replace(/^(the|a|an) (?=\S)/, "");
  return drop(folderName) !== "" && drop(folderName) === drop(mbName);
}

export interface ReleaseCandidate {
  id: string;
  title: string;
  artist: string;
  /** MusicBrainz's own match score, 0..100. */
  score: number;
  trackCount: number | null;
  /** "2019", "2019-05", or "2019-05-06". */
  date: string | null;
  status: string | null;
  country: string | null;
}

export const MIN_SEARCH_SCORE = 80;
export const MIN_ALBUM_SIMILARITY = 0.8;

/**
 * The release that is this album, or null when none clearly is: a wrong match (someone else's album with the same
 * name) is worse than none, so the name must match closely AND the artist must be the same AND the release must be
 * able to hold the tracks we have. Among matches, prefers the same track count, official releases and the earliest date.
 */
export function pickRelease(candidates: ReleaseCandidate[], want: { artist: string; album: string; trackCount: number }): ReleaseCandidate | null {
  const ok = candidates.filter(
    (c) =>
      c.score >= MIN_SEARCH_SCORE &&
      nameSimilarity(c.title, want.album) >= MIN_ALBUM_SIMILARITY &&
      sameArtist(want.artist, c.artist) &&
      (c.trackCount === null || c.trackCount >= want.trackCount)
  );
  const rank = (c: ReleaseCandidate): [number, number, number, string, string] => [
    c.trackCount === want.trackCount ? 0 : 1,
    c.status === "Official" ? 0 : 1,
    -Math.round(nameSimilarity(c.title, want.album) * 100),
    c.date || "9999", // no date sorts last
    c.id,
  ];
  ok.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
  return ok[0] ?? null;
}

/** The year in a MusicBrainz date, or null. */
export function yearOfDate(date: string | null | undefined): number | null {
  const m = /^(\d{4})(?:-|$)/.exec(date ?? "");
  const y = m ? Number(m[1]) : NaN;
  return y >= 1000 && y <= 2100 ? y : null;
}

export interface ReleaseTrack {
  disc: number;
  position: number;
  title: string;
  recordingId: string | null;
}

export interface LocalTrack {
  id: string;
  disc: number | null;
  track: number | null;
  name: string;
}

/**
 * Pairs our tracks with the release's by disc and track number. Only used when the numbers agree with the names closely
 * enough (a renumbered or mis-ordered folder must not be given another song's title): the pair's titles must be similar,
 * or (when the local name is just the file's name) the position must be exact and unique.
 */
export function mapTracks(local: LocalTrack[], release: ReleaseTrack[]): Map<string, ReleaseTrack> {
  const byPosition = new Map<string, ReleaseTrack>();
  const dupes = new Set<string>();
  const hasDiscs = new Set(release.map((r) => r.disc)).size > 1;
  for (const r of release) {
    const key = `${hasDiscs ? r.disc : 1}:${r.position}`;
    if (byPosition.has(key)) dupes.add(key);
    byPosition.set(key, r);
  }
  const out = new Map<string, ReleaseTrack>();
  for (const l of local) {
    if (l.track === null) continue;
    const key = `${hasDiscs ? (l.disc ?? 1) : 1}:${l.track}`;
    if (dupes.has(key)) continue;
    const r = byPosition.get(key);
    if (r && nameSimilarity(l.name, r.title) >= 0.5) out.set(l.id, r);
  }
  return out;
}

// ── Network ──────────────────────────────────────────────────────────────

type Fetch = typeof fetch;

export interface MusicBrainzClient {
  searchReleases(artist: string, album: string): Promise<ReleaseCandidate[]>;
  getRelease(id: string): Promise<{ id: string; title: string; artist: string; artistId: string | null; date: string | null; tracks: ReleaseTrack[] } | null>;
  /** The front cover (500 px), or null if the release has none. */
  getFrontCover(releaseId: string): Promise<{ contentType: "image/jpeg" | "image/png"; bytes: Uint8Array } | null>;
}

interface MbSearchRelease {
  id: string;
  title: string;
  score?: number;
  status?: string;
  country?: string;
  date?: string;
  "track-count"?: number;
  "artist-credit"?: { name?: string; artist?: { name?: string } }[];
}

const creditName = (credit: MbSearchRelease["artist-credit"]): string => (credit ?? []).map((c) => c.name ?? c.artist?.name ?? "").join("").trim();

/** Escapes what Lucene (MusicBrainz's search syntax) would read as syntax, inside a quoted phrase. */
export const luceneQuote = (s: string): string => `"${s.replace(/(["\\])/g, "\\$1")}"`;

/** The response body, or null if it is longer than `max` (stopped as soon as it is). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0); // an empty body
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function createMusicBrainz(opts: { fetch?: Fetch; userAgent?: string; minIntervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): MusicBrainzClient {
  const doFetch = opts.fetch ?? fetch;
  const ua = opts.userAgent ?? MB_USER_AGENT;
  const gap = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;
  // One request at a time, spaced out, however many callers there are.
  let chain: Promise<unknown> = Promise.resolve();
  const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = last + gap - now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        last = now();
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };

  async function mb<T>(path: string): Promise<T | null> {
    return throttled(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await doFetch(`${MB_API}${path}`, { headers: { "user-agent": ua, accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.ok) return (await res.json()) as T;
        if (res.status === 404) return null;
        if (res.status === 503 || res.status === 429) {
          await sleep(2000 * (attempt + 1)); // rate-limited: wait and try again
          continue;
        }
        throw new Error(`MusicBrainz answered ${res.status}`);
      }
      throw new Error("MusicBrainz is busy; try again later");
    });
  }

  return {
    async searchReleases(artist, album) {
      const q = `release:${luceneQuote(album)} AND artist:${luceneQuote(artist)}`;
      const data = await mb<{ releases?: MbSearchRelease[] }>(`/release/?query=${encodeURIComponent(q)}&fmt=json&limit=15`);
      return (data?.releases ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        artist: creditName(r["artist-credit"]),
        score: r.score ?? 0,
        trackCount: typeof r["track-count"] === "number" ? r["track-count"] : null,
        date: r.date || null,
        status: r.status ?? null,
        country: r.country ?? null,
      }));
    },

    async getRelease(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Not a MusicBrainz id");
      const data = await mb<{
        id: string;
        title: string;
        date?: string;
        "artist-credit"?: { name?: string; artist?: { id?: string; name?: string } }[];
        media?: { position?: number; tracks?: { position?: number; title?: string; recording?: { id?: string } }[] }[];
      }>(`/release/${id}?inc=recordings+artist-credits&fmt=json`);
      if (!data) return null;
      const tracks: ReleaseTrack[] = [];
      for (const [i, m] of (data.media ?? []).entries()) {
        for (const t of m.tracks ?? []) {
          if (typeof t.position === "number" && t.title) tracks.push({ disc: m.position ?? i + 1, position: t.position, title: t.title, recordingId: t.recording?.id ?? null });
        }
      }
      const credit = data["artist-credit"] ?? [];
      return { id: data.id, title: data.title, artist: creditName(credit), artistId: credit.length === 1 ? (credit[0].artist?.id ?? null) : null, date: data.date ?? null, tracks };
    },

    async getFrontCover(releaseId) {
      if (!/^[0-9a-f-]{36}$/i.test(releaseId)) throw new Error("Not a MusicBrainz id");
      // The archive answers with a redirect to the image's own address; follow it by hand, and only to archive.org hosts.
      let url = `${CAA}/release/${releaseId}/front-500`;
      for (let hop = 0; ; hop++) {
        const res = await doFetch(url, { headers: { "user-agent": ua }, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          if (!next || hop >= MAX_REDIRECTS) return null;
          const target = new URL(next, url);
          if (target.protocol !== "https:" || !COVER_HOSTS.some((re) => re.test(target.hostname))) return null;
          url = target.toString();
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Cover Art Archive answered ${res.status}`);
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "image/jpeg" && type !== "image/png") return null;
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return null;
        const bytes = await readCapped(res, MAX_COVER_BYTES);
        return bytes && bytes.length > 0 ? { contentType: type, bytes } : null;
      }
    },
  };
}
