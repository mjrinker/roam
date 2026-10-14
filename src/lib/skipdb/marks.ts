/**
 * Intro, recap, credits and preview times marked by hand. Marked on the film's clock in the player and stored per video file like scene
 * marks. Where a hand-marked time exists for a kind it is used instead of SkipDB's, chosen at the moment the buttons are built: SkipDB's
 * times are never copied into these records, or compared with them (its terms ask for that to stay so).
 */
import { rowWindows, type MarkRow, type RowWindow } from "@/lib/content-filter/marks";
import type { SkipKind, SkipSegment } from "@/lib/skipdb/client";

export const SKIP_KINDS: SkipKind[] = ["intro", "recap", "outro", "preview"];
export const SKIP_KIND_LABELS: Record<SkipKind, string> = { intro: "Intro", recap: "Recap", outro: "Credits", preview: "Next-time preview" };
const isKind = (v: unknown): v is SkipKind => typeof v === "string" && (SKIP_KINDS as string[]).includes(v);
const round = (n: number) => Math.round(n * 10) / 10;
export const MAX_SKIP_MARKS = 20;

/** What the player may send: one of each kind at most (the last wins), sane and within the film. */
export function cleanSkipMarks(input: unknown, durationSeconds: number): SkipSegment[] {
  if (!Array.isArray(input)) return [];
  const byKind = new Map<SkipKind, SkipSegment>();
  for (const raw of input.slice(0, MAX_SKIP_MARKS)) {
    const m = raw as Partial<SkipSegment>;
    if (!isKind(m.kind)) continue;
    const start = Number(m.startSeconds);
    const end = Number(m.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 2 || start >= durationSeconds) continue;
    byKind.set(m.kind, { kind: m.kind, startSeconds: round(start), endSeconds: round(Math.min(end, durationSeconds)) });
  }
  return [...byKind.values()].sort((a, b) => a.startSeconds - b.startSeconds);
}

/** The part of a film-clock mark inside one file's window, as a file-relative mark; null when none. */
function clip(m: SkipSegment, w: RowWindow): SkipSegment | null {
  const from = Math.max(m.startSeconds, w.clockStart);
  const to = Math.min(m.endSeconds, w.clockStart + w.length);
  return to - from < 1 ? null : { kind: m.kind, startSeconds: round(w.fileOffset + (from - w.clockStart)), endSeconds: round(w.fileOffset + (to - w.clockStart)) };
}
function lift(m: SkipSegment, w: RowWindow): SkipSegment | null {
  const from = Math.max(m.startSeconds, w.fileOffset);
  const to = Math.min(m.endSeconds, w.fileOffset + w.length);
  return to - from < 1 ? null : { kind: m.kind, startSeconds: round(w.clockStart + (from - w.fileOffset)), endSeconds: round(w.clockStart + (to - w.fileOffset)) };
}

/** Each file's share of marks made on the film's clock. */
export function splitSkipMarks(marks: readonly SkipSegment[], windows: readonly RowWindow[]): Map<string, SkipSegment[]> {
  return new Map(windows.map((w) => [w.rowId, marks.map((m) => clip(m, w)).filter((m): m is SkipSegment => m !== null)]));
}

/** Per-file marks back onto the film's clock; where a mark was split across parts, the pieces are joined again. */
export function liftSkipMarks(perRow: ReadonlyMap<string, readonly SkipSegment[] | null | undefined>, windows: readonly RowWindow[]): SkipSegment[] {
  const byKind = new Map<SkipKind, SkipSegment>();
  for (const w of windows) {
    for (const m of perRow.get(w.rowId) ?? []) {
      const l = lift(m, w);
      if (!l) continue;
      const have = byKind.get(l.kind);
      byKind.set(l.kind, have ? { kind: l.kind, startSeconds: Math.min(have.startSeconds, l.startSeconds), endSeconds: Math.max(have.endSeconds, l.endSeconds) } : l);
    }
  }
  return [...byKind.values()].sort((a, b) => a.startSeconds - b.startSeconds);
}

/** A file's stored marks with those inside its window replaced (marks of another episode in a combined file stay). */
export function replaceSkipWindow(existing: readonly SkipSegment[] | null | undefined, w: RowWindow, incoming: readonly SkipSegment[]): SkipSegment[] {
  const keep = (existing ?? []).filter((m) => {
    const mid = (m.startSeconds + m.endSeconds) / 2;
    return mid < w.fileOffset || mid >= w.fileOffset + w.length;
  });
  return [...keep, ...incoming].sort((a, b) => a.startSeconds - b.startSeconds);
}

/** The hand-marked times of a film's files on its clock. */
export function skipMarksFromRows(rows: readonly (MarkRow & { skipMarks?: readonly SkipSegment[] | null })[]): SkipSegment[] {
  const windows = rowWindows(rows);
  return windows.length === 0 ? [] : liftSkipMarks(new Map(rows.map((r) => [r.id, r.skipMarks])), windows);
}

/** Hand-marked times win over SkipDB's, one kind at a time. */
export function preferOwn(own: readonly SkipSegment[], fromSkipdb: readonly SkipSegment[]): SkipSegment[] {
  const kinds = new Set(own.map((m) => m.kind));
  return [...own, ...fromSkipdb.filter((m) => !kinds.has(m.kind))].sort((a, b) => a.startSeconds - b.startSeconds);
}
