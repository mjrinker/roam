import { playbackCues } from "@/lib/content-filter/playback";
import type { FilterCue } from "@/lib/content-filter/categories";

export interface CueRow {
  partIndex: number;
  durationSeconds: number | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
  contentCues: FilterCue[] | null;
}

/** A movie's or episode's cues from its files (one version's rows), on the player's clock: parts follow one another, a combined file's slice keeps its window. */
export function cuesFromRows(rows: readonly CueRow[]): FilterCue[] {
  const ordered = [...rows].sort((a, b) => a.partIndex - b.partIndex);
  if (ordered.length === 0 || ordered.some((r) => r.durationSeconds == null && r.trimDurationSeconds == null)) return [];
  let cursor = 0;
  const segments = ordered.map((r) => {
    const trimmed = r.trimDurationSeconds != null;
    const duration = trimmed ? r.trimDurationSeconds! : r.durationSeconds!;
    const offset = r.trimStartSeconds ?? 0;
    const seg = {
      startSeconds: cursor,
      durationSeconds: duration,
      ...(trimmed ? { inFileOffsetSeconds: offset, inFileEndSeconds: offset + duration } : {}),
      cues: r.contentCues,
    };
    cursor += duration;
    return seg;
  });
  return playbackCues(segments, cursor);
}
