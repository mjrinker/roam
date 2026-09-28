/**
 * Pure math for estimating where to cut a multi-episode file ("S01E05-E06")
 * into each episode's own playback window. No DB or network access here —
 * see episode-split-pass.ts for the part that reads/writes media_files.
 *
 * There's no server-side video processing, so a "split" is only metadata:
 * an in-file offset and a window length per episode. The manifest carries
 * it (see PlaySegment/buildPlaySegment in lib/player) and the player
 * enforces it. It's an estimate, not frame-accurate.
 */

export const CHAPTER_SNAP_WINDOW_SECONDS = 90;
export const MIN_WINDOW_SECONDS = 60;

export interface EpisodeWindow {
  startSeconds: number;
  durationSeconds: number;
}

/** A chapter's start time, relative to the start of the file. */
export interface FileChapter {
  startSeconds: number;
}

/**
 * Splits one physical file's total duration into `runtimes.length`
 * estimated playback windows, proportional to each episode's TMDB runtime
 * (equal shares if any runtime is missing or non-positive). Each interior
 * cut point snaps to the nearest embedded chapter within
 * CHAPTER_SNAP_WINDOW_SECONDS of its proportional estimate, when doing so
 * wouldn't push either neighboring window below MIN_WINDOW_SECONDS — a
 * snap that would is reverted to its own raw estimate, independent of
 * whether any other cut snapped.
 *
 * Returns null if the file isn't long enough for every episode to get at
 * least MIN_WINDOW_SECONDS on average, in which case the caller should
 * play the file whole rather than trust a meaningless split.
 */
export function computeEpisodeSplit(
  fileSeconds: number,
  runtimes: (number | null)[],
  chapters: FileChapter[] | null
): EpisodeWindow[] | null {
  const n = runtimes.length;
  if (n < 2 || fileSeconds < n * MIN_WINDOW_SECONDS) return null;

  const allPositive = runtimes.every((r): r is number => r != null && r > 0);
  const weights = allPositive ? runtimes : new Array(n).fill(1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // n-1 interior cut points; the file's own start/end are the outer edges.
  const rawCuts: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < n - 1; i++) {
    cumulative += weights[i];
    rawCuts.push((fileSeconds * cumulative) / totalWeight);
  }

  const finalCuts = rawCuts.map((raw, i) => {
    const snapped = snapToNearestChapter(raw, fileSeconds, chapters);
    if (snapped === raw) return raw;
    const prevRaw = i === 0 ? 0 : rawCuts[i - 1];
    const nextRaw = i === n - 2 ? fileSeconds : rawCuts[i + 1];
    const ok = snapped - prevRaw >= MIN_WINDOW_SECONDS && nextRaw - snapped >= MIN_WINDOW_SECONDS;
    return ok ? snapped : raw;
  });

  // Defensive floor: two independently-accepted snaps could in principle
  // still end up out of order relative to EACH OTHER (each is only checked
  // against its raw neighbors, not the other's post-snap position). A
  // negative-or-zero-length window would corrupt playback, so clamp rather
  // than trust the math above blindly.
  for (let i = 1; i < finalCuts.length; i++) {
    finalCuts[i] = Math.max(finalCuts[i], finalCuts[i - 1] + 0.01);
  }
  if (finalCuts.length > 0) {
    finalCuts[finalCuts.length - 1] = Math.min(finalCuts[finalCuts.length - 1], fileSeconds - 0.01);
  }

  const boundaries = [0, ...finalCuts, fileSeconds];
  return boundaries.slice(0, -1).map((start, i) => ({
    startSeconds: start,
    durationSeconds: boundaries[i + 1] - start,
  }));
}

function snapToNearestChapter(raw: number, fileSeconds: number, chapters: FileChapter[] | null): number {
  if (!chapters || chapters.length === 0) return raw;
  let best = raw;
  let bestDist = CHAPTER_SNAP_WINDOW_SECONDS;
  for (const chapter of chapters) {
    // Strictly inside the file — a chapter AT 0 or at the file's own end
    // isn't a useful cut candidate.
    if (chapter.startSeconds <= 0 || chapter.startSeconds >= fileSeconds) continue;
    const dist = Math.abs(chapter.startSeconds - raw);
    if (dist <= bestDist) {
      best = chapter.startSeconds;
      bestDist = dist;
    }
  }
  return best;
}

export interface FilePart {
  boxFileId: string;
  /** This part's own duration, in isolation (not the combined total). */
  durationSeconds: number;
}

/**
 * Splits one GLOBAL window (in time across ALL ordered parts, e.g. from
 * computeEpisodeSplit run over the parts' summed duration) into per-part
 * LOCAL trims. A combined multi-episode file that's ALSO split across
 * multiple physical parts needs this: one episode's estimated slice can
 * start partway through one part and end partway through the next, so its
 * playback becomes two (or more) ordinary trimmed segments — the seamless
 * player already knows how to play multiple segments for one owner, so
 * nothing there needs to change.
 *
 * Returns one entry per part the window actually overlaps, in part order.
 * A part with NO overlap (the window doesn't touch it at all) is simply
 * absent from the result — the caller (episode-split-pass.ts) uses that
 * absence to mark that row excluded from this episode's playback
 * (trimDurationSeconds = 0, filtered out by the manifest).
 */
export function splitWindowAcrossParts(
  parts: FilePart[],
  window: EpisodeWindow
): { boxFileId: string; trimStartSeconds: number; trimDurationSeconds: number }[] {
  const windowEnd = window.startSeconds + window.durationSeconds;
  const results: { boxFileId: string; trimStartSeconds: number; trimDurationSeconds: number }[] = [];
  let partStart = 0;
  for (const part of parts) {
    const partEnd = partStart + part.durationSeconds;
    const overlapStart = Math.max(partStart, window.startSeconds);
    const overlapEnd = Math.min(partEnd, windowEnd);
    if (overlapEnd > overlapStart) {
      results.push({
        boxFileId: part.boxFileId,
        trimStartSeconds: overlapStart - partStart,
        trimDurationSeconds: overlapEnd - overlapStart,
      });
    }
    partStart = partEnd;
  }
  return results;
}

export type TrimTarget =
  | { kind: "skip" }
  | { kind: "reset" }
  | { kind: "whole" }
  | {
      kind: "split";
      /**
       * One entry per (episode, part) pair the episode's window actually
       * overlaps. A part a given episode doesn't appear here for should be
       * excluded from that episode's playback entirely (see
       * splitWindowAcrossParts).
       */
      windows: { episodeNumber: number; boxFileId: string; trimStartSeconds: number; trimDurationSeconds: number }[];
    };

export interface OwnerRow {
  episodeNumber: number;
  /** How many media_files rows this episode owns, TOTAL (not just within this combined file) — used to detect an unrelated extra file this episode also happens to own. */
  ownerRowCount: number;
  runtimeSeconds: number | null;
  trimSource: "auto" | "manual" | null;
}

export interface PlanCombinedTrimsInput {
  /** Every episode number the file's name actually parses to (parseEpisodeFileName().episodes). */
  parsedEpisodes: number[];
  /** The media_files rows currently claiming this combined file, one per (owning episode, physical part) pair. */
  owners: OwnerRow[];
  /** This combined file's physical parts, in playback order. Each part's durationSeconds is null if that part isn't probed yet. */
  parts: { boxFileId: string; durationSeconds: number | null; chapters: FileChapter[] | null }[];
}

/**
 * Decides what a combined file's rows should have for their trim columns.
 * See episode-split-pass.ts for how this gets applied to actual rows.
 * Subsumes the single-physical-part case too (parts.length === 1): the
 * per-part split step below is a no-op there, since a window can't span a
 * part boundary that doesn't exist.
 *
 * Decision order:
 * 1. Any owner is pinned ('manual') → skip entirely, whatever else changed.
 * 2. The file no longer parses to 2+ episodes (renamed to an ordinary file)
 *    → reset (clear any stale trim from when it WAS combined).
 * 3. The owning episodes don't exactly match the file's parsed span (the
 *    groupEpisodeFiles overlap case: a standalone file took one of the
 *    numbers) → whole, untrimmed.
 * 4. Any owner's TOTAL row count doesn't equal this file's part count —
 *    meaning that episode also owns some OTHER, unrelated file — → whole;
 *    not a case worth reasoning about further.
 * 5. Not every part is probed yet → skip; there's nothing to compute from.
 * 6. Otherwise → split, across the parts' SUMMED duration (with each
 *    part's chapters offset into that combined timeline). If
 *    computeEpisodeSplit can't produce one (too short overall), fall back
 *    to whole rather than a meaningless trim.
 */
export function planCombinedTrims(input: PlanCombinedTrimsInput): TrimTarget {
  const { parsedEpisodes, owners, parts } = input;

  if (owners.some((o) => o.trimSource === "manual")) return { kind: "skip" };
  if (parsedEpisodes.length < 2) return { kind: "reset" };

  const ownerNumbers = owners.map((o) => o.episodeNumber).sort((a, b) => a - b);
  const parsedSorted = [...parsedEpisodes].sort((a, b) => a - b);
  const sameSet =
    ownerNumbers.length === parsedSorted.length &&
    ownerNumbers.every((num, i) => num === parsedSorted[i]);
  if (!sameSet) return { kind: "whole" };

  if (owners.some((o) => o.ownerRowCount !== parts.length)) return { kind: "whole" };

  if (parts.some((p) => p.durationSeconds == null)) return { kind: "skip" };

  let cumulative = 0;
  const globalChapters: FileChapter[] = [];
  const filePartsForSplit: FilePart[] = [];
  for (const part of parts) {
    const durationSeconds = part.durationSeconds!;
    for (const c of part.chapters ?? []) globalChapters.push({ startSeconds: c.startSeconds + cumulative });
    filePartsForSplit.push({ boxFileId: part.boxFileId, durationSeconds });
    cumulative += durationSeconds;
  }

  const ordered = [...owners].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const split = computeEpisodeSplit(
    cumulative,
    ordered.map((o) => o.runtimeSeconds),
    globalChapters.length > 0 ? globalChapters : null
  );
  if (!split) return { kind: "whole" };

  const windows = ordered.flatMap((o, i) =>
    splitWindowAcrossParts(filePartsForSplit, split[i]).map((w) => ({ episodeNumber: o.episodeNumber, ...w }))
  );
  return { kind: "split", windows };
}
