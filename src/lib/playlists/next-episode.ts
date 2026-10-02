/**
 * Which episode a show entry plays, and what follows it. Pure: callers pass
 * the show's CANDIDATE episodes (those with a media file that the viewing
 * profile's rating limits allow) with that viewer's progress on each.
 */

export interface EpisodeCandidate {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  finished: boolean;
  /** Seconds watched; 0 when never started. */
  progressSeconds: number;
  /** When this viewer's progress last changed; null when never started. */
  updatedAt: Date | null;
}

export interface EpisodePick {
  episodeId: string;
  /** True when every candidate was already finished, so the show replays from the start. */
  replay: boolean;
}

/** Playing order: seasons 1+ first (season, episode, id), season 0 (specials) last. */
export function playingOrder(candidates: readonly EpisodeCandidate[]): EpisodeCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(a.seasonNumber === 0) - Number(b.seasonNumber === 0) ||
      a.seasonNumber - b.seasonNumber ||
      a.episodeNumber - b.episodeNumber ||
      a.id.localeCompare(b.id)
  );
}

/**
 * The episode to start a show entry on: the most recently updated unfinished
 * episode that has progress; else the first unfinished one; else, when
 * everything is finished, the first episode (a non-special if there is one)
 * with `replay` on. Null when the show has no candidates.
 */
export function pickStartEpisode(candidates: readonly EpisodeCandidate[]): EpisodePick | null {
  const ordered = playingOrder(candidates);
  if (ordered.length === 0) return null;

  const inProgress = ordered
    .filter((c) => !c.finished && c.progressSeconds > 0)
    .sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
    )[0];
  if (inProgress) return { episodeId: inProgress.id, replay: false };

  const firstUnfinished = ordered.find((c) => !c.finished);
  if (firstUnfinished) return { episodeId: firstUnfinished.id, replay: false };

  return { episodeId: ordered[0].id, replay: true };
}

/**
 * The episode after `currentEpisodeId` inside a queue. In replay mode that is
 * simply the next candidate in order; otherwise the first UNFINISHED candidate
 * strictly after the current one. Null means the show is done and the queue
 * should move to the next playlist item.
 */
export function nextEpisodeAfter(
  candidates: readonly EpisodeCandidate[],
  currentEpisodeId: string,
  replay: boolean
): string | null {
  const ordered = playingOrder(candidates);
  const at = ordered.findIndex((c) => c.id === currentEpisodeId);
  const rest = at === -1 ? [] : ordered.slice(at + 1);
  const next = replay ? rest[0] : rest.find((c) => !c.finished);
  return next?.id ?? null;
}
