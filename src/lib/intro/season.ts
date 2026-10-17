/**
 * Intro and credits times for the episodes of one season, from their sound. `listen` is how a stretch of an episode is heard (ffmpeg in the real
 * thing, made-up sound in tests); everything else is the rules about what counts as an intro or as credits.
 */
import type { SkipSegment } from "@/lib/skipdb/client";
import { detectShared, MIN_EPISODES, type Detected, type EpisodeAudio } from "@/lib/intro/detect";
import { fingerprintPhases } from "@/lib/intro/fingerprint";

/** The opening is looked for in the first eight minutes, the credits in the last seven. */
export const INTRO_WINDOW_SECONDS = 480;
export const OUTRO_WINDOW_SECONDS = 420;
/** Credits must reach the end of the episode, give or take a closing sting. */
export const OUTRO_REACHES_END_WITHIN = 35;
const MIN_OUTRO_START_FRACTION = 0.5;

/** The stretch of an episode to listen to for each kind (credits only for an episode long enough to have its opening well apart from them). */
export function windowsFor(durationSeconds: number): { intro: { start: number; seconds: number }; outro: { start: number; seconds: number } | null } {
  return {
    intro: { start: 0, seconds: Math.min(INTRO_WINDOW_SECONDS, Math.floor(durationSeconds * 0.5)) },
    outro: durationSeconds >= 2 * OUTRO_WINDOW_SECONDS ? { start: durationSeconds - OUTRO_WINDOW_SECONDS, seconds: OUTRO_WINDOW_SECONDS } : null,
  };
}

/** What to keep from what was found for one episode: an opening within the first window, credits that run to the end. */
export function marksFrom(intro: Detected | null, outro: Detected | null, durationSeconds: number): SkipSegment[] {
  const marks: SkipSegment[] = [];
  if (intro && intro.startSeconds >= 0 && intro.endSeconds <= durationSeconds && intro.endSeconds - intro.startSeconds >= 15) {
    marks.push({ kind: "intro", startSeconds: round(intro.startSeconds), endSeconds: round(intro.endSeconds) });
  }
  if (outro && outro.startSeconds >= durationSeconds * MIN_OUTRO_START_FRACTION && outro.endSeconds >= durationSeconds - OUTRO_REACHES_END_WITHIN && outro.endSeconds - outro.startSeconds >= 15) {
    marks.push({ kind: "outro", startSeconds: round(outro.startSeconds), endSeconds: round(durationSeconds) });
  }
  return marks.sort((a, b) => a.startSeconds - b.startSeconds);
}
const round = (n: number) => Math.round(n * 10) / 10;

export interface SeasonEpisode {
  id: string;
  durationSeconds: number;
}
export type Listen = (episodeId: string, startSeconds: number, seconds: number) => Promise<Float32Array | null>;

/** Runs `task` on every item, at most `limit` at a time, keeping the order of the results. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await task(items[i]);
      }
    })
  );
  return out;
}

/** One kind's fingerprints for every episode that could be heard. */
async function listenToAll(episodes: readonly SeasonEpisode[], listen: Listen, kind: "intro" | "outro", concurrency: number): Promise<EpisodeAudio[]> {
  const heard = await pool(episodes, concurrency, async (e) => {
    const w = windowsFor(e.durationSeconds)[kind];
    if (!w) return null;
    const pcm = await listen(e.id, w.start, w.seconds);
    return pcm ? ({ id: e.id, fps: fingerprintPhases(pcm), windowStart: w.start } satisfies EpisodeAudio) : null;
  });
  return heard.filter((h): h is EpisodeAudio => h !== null);
}

/**
 * The times found for each episode of a season (an empty list for one with nothing found; a season too small to compare gets nothing at all).
 * `kinds` says whether to look for the opening, the credits, or both.
 */
export async function detectSeasonMarks(
  episodes: readonly SeasonEpisode[],
  listen: Listen,
  opts: { kinds?: ("intro" | "outro")[]; concurrency?: number; references?: number } = {}
): Promise<Map<string, SkipSegment[]> | null> {
  if (episodes.length < MIN_EPISODES) return null;
  const kinds = opts.kinds ?? ["intro", "outro"];
  const found = new Map<"intro" | "outro", Map<string, Detected | null>>();
  for (const kind of kinds) found.set(kind, detectShared(await listenToAll(episodes, listen, kind, opts.concurrency ?? 3), { references: opts.references }));
  return new Map(episodes.map((e) => [e.id, marksFrom(found.get("intro")?.get(e.id) ?? null, found.get("outro")?.get(e.id) ?? null, e.durationSeconds)]));
}
