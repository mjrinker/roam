/**
 * Skip times for intros, recaps, credits and "next time" previews, from SkipDB (https://skipdb.tv, open data under the ODbL). Read live,
 * only to show a "Skip intro" style button to the person watching: Roam keeps no database of these records (only a short-lived memory
 * cache, to avoid asking twice in a row), which is what its terms ask for. Nothing is ever sent but the title's IMDb id, season and
 * episode, and the length of the video. Turn it off with SKIPDB_URL=off.
 */
export type SkipKind = "intro" | "recap" | "outro" | "preview";

export interface SkipSegment {
  kind: SkipKind;
  startSeconds: number;
  endSeconds: number;
  /** Set on a time marked by hand in Roam (so SkipDB is not credited for it). */
  source?: "own";
}

const DEFAULT_BASE = "https://api.skipdb.tv";
const KINDS: SkipKind[] = ["intro", "recap", "outro", "preview"];
/** Longest a segment of each kind plausibly is; a longer one is a mistake in the data. */
const MAX_SECONDS: Record<SkipKind, number> = { intro: 300, recap: 300, preview: 300, outro: 1800 };
/** Entries SkipDB itself is unsure of are left out. */
const MIN_CONFIDENCE = 0.5;

/** Where to ask, or null when switched off. */
export function skipdbBase(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.SKIPDB_URL?.trim();
  if (v === "off" || v === "0" || v === "false") return null;
  const raw = (v || DEFAULT_BASE).replace(/\/+$/, "");
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** What SkipDB answered, cleaned: known kinds only, sane times, within the video, and confident enough. */
export function parseSegments(body: unknown, durationSeconds: number): SkipSegment[] {
  const segments = (body as { segments?: Record<string, unknown> } | null)?.segments;
  if (!segments || typeof segments !== "object") return [];
  const out: SkipSegment[] = [];
  for (const kind of KINDS) {
    const s = segments[kind] as { start_ms?: unknown; end_ms?: unknown; confidence?: unknown } | null | undefined;
    if (!s || typeof s.start_ms !== "number" || typeof s.end_ms !== "number") continue;
    if (typeof s.confidence === "number" && s.confidence < MIN_CONFIDENCE) continue;
    const start = Math.max(0, s.start_ms / 1000);
    const end = Math.min(s.end_ms / 1000, durationSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2 || end - start > MAX_SECONDS[kind]) continue;
    out.push({ kind, startSeconds: Math.round(start * 10) / 10, endSeconds: Math.round(end * 10) / 10 });
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

const HIT_MS = 12 * 3600_000;
const MISS_MS = 3600_000;
const FAIL_MS = 5 * 60_000;
const MAX_ENTRIES = 2000;
const memory = new Map<string, { at: number; ttl: number; segments: SkipSegment[] }>();

/** For tests: forget what was remembered. */
export const resetSkipdbMemory = () => memory.clear();

/** The skip times for one movie or episode (an empty list when there are none, it is switched off, or it can't be reached quickly). */
export async function skipSegmentsFor(
  target: { imdbId: string | null; season?: number; episode?: number },
  durationSeconds: number,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}
): Promise<SkipSegment[]> {
  const base = skipdbBase(opts.env);
  if (!base || !target.imdbId || !/^tt\d{5,12}$/.test(target.imdbId) || !(durationSeconds > 60)) return [];
  const isEpisode = target.season !== undefined && target.episode !== undefined && target.season >= 0 && target.episode >= 0;
  // Their matching shifts times to fit a copy of a different length, so the length is part of the question (and of what is remembered).
  const key = `${target.imdbId}|${isEpisode ? `${target.season}|${target.episode}` : "movie"}|${Math.round(durationSeconds / 10) * 10}`;
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.segments;

  const params = new URLSearchParams({ imdb_id: target.imdbId, duration: String(Math.round(durationSeconds)) });
  if (isEpisode) {
    params.set("season", String(target.season));
    params.set("episode", String(target.episode));
  }
  let segments: SkipSegment[] = [];
  let ttl = FAIL_MS;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}/api/segments?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 1500), cache: "no-store" });
    if (res.ok) {
      segments = parseSegments(await res.json().catch(() => null), durationSeconds);
      ttl = segments.length > 0 ? HIT_MS : MISS_MS;
    }
  } catch {
    // Not reachable in time: no buttons this time, and not asked again for a few minutes.
  }
  if (memory.size >= MAX_ENTRIES) memory.delete(memory.keys().next().value as string);
  memory.set(key, { at: Date.now(), ttl, segments });
  return segments;
}
