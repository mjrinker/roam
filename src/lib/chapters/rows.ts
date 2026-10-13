import { playbackChapters, type Chapter } from "@/lib/chapters/chapters";

export interface ChapterRow {
  partIndex: number;
  durationSeconds: number | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
  chapters: { title: string; startSeconds: number }[] | null;
}

/**
 * A movie's or episode's chapters from its files (one version's rows), on the same clock the player uses: parts follow one another,
 * a combined file's slice keeps only its own window. Empty until every part's length is known, and when there are fewer than two.
 */
export function chaptersFromRows(rows: readonly ChapterRow[]): Chapter[] {
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
      chapters: r.chapters,
    };
    cursor += duration;
    return seg;
  });
  return playbackChapters(segments, cursor);
}
