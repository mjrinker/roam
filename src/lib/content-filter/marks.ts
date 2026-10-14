/**
 * Scenes marked by hand in the player. The player works on the whole film's clock; scene files and stored cues are per video file (a movie
 * in parts has one per part; an episode cut from a combined file uses a slice of one). This moves cues between the two, replaces just the
 * marks inside one file's window, and writes the Movie Content Filter text for a file.
 */
import { isFilterSeverity, type FilterCue } from "@/lib/content-filter/categories";

/** The format's own nine categories: a hand-marked scene must be readable by any program that reads the format. */
export const MARK_CATEGORIES = ["violence", "language", "sex", "nudity", "fear", "drugs", "discrimination", "commercial", "dispensable"] as const;
export type MarkCategory = (typeof MARK_CATEGORIES)[number];
export const isMarkCategory = (v: unknown): v is MarkCategory => typeof v === "string" && (MARK_CATEGORIES as readonly string[]).includes(v);

export const MAX_MARKS = 400;
const MAX_NOTE = 160;

export interface MarkRow {
  id: string;
  partIndex: number;
  durationSeconds: number | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
}

/** Where one file's playable window sits on the film's clock. */
export interface RowWindow {
  rowId: string;
  /** The window starts this far into the file (0 unless it is an episode's slice of a combined file). */
  fileOffset: number;
  length: number;
  /** And starts here on the film's clock. */
  clockStart: number;
}

/** The windows of a film's files in order; empty until every file's length is known. */
export function rowWindows(rows: readonly MarkRow[]): RowWindow[] {
  const ordered = [...rows].sort((a, b) => a.partIndex - b.partIndex);
  if (ordered.length === 0 || ordered.some((r) => r.durationSeconds == null && r.trimDurationSeconds == null)) return [];
  let clock = 0;
  return ordered.map((r) => {
    const length = r.trimDurationSeconds ?? r.durationSeconds!;
    const w: RowWindow = { rowId: r.id, fileOffset: r.trimDurationSeconds != null ? (r.trimStartSeconds ?? 0) : 0, length, clockStart: clock };
    clock += length;
    return w;
  });
}

/** The part of a film-clock cue that falls inside one window, as a file-relative cue; null when none does. */
function clip(cue: FilterCue, w: RowWindow): FilterCue | null {
  const from = Math.max(cue.startSeconds, w.clockStart);
  const to = Math.min(cue.endSeconds, w.clockStart + w.length);
  if (to - from < 0.05) return null;
  return { ...cue, startSeconds: round(w.fileOffset + (from - w.clockStart)), endSeconds: round(w.fileOffset + (to - w.clockStart)) };
}

/** A file-relative cue on the film's clock, or null when it is outside the window. */
function lift(cue: FilterCue, w: RowWindow): FilterCue | null {
  const from = Math.max(cue.startSeconds, w.fileOffset);
  const to = Math.min(cue.endSeconds, w.fileOffset + w.length);
  if (to - from < 0.05) return null;
  return { ...cue, startSeconds: round(w.clockStart + (from - w.fileOffset)), endSeconds: round(w.clockStart + (to - w.fileOffset)) };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** What marked on the film's clock belongs to each file. A scene across two parts is two cues. */
export function splitToRows(cues: readonly FilterCue[], windows: readonly RowWindow[]): Map<string, FilterCue[]> {
  const out = new Map<string, FilterCue[]>();
  for (const w of windows) out.set(w.rowId, cues.map((c) => clip(c, w)).filter((c): c is FilterCue => c !== null));
  return out;
}

/** Cues stored per file, on the film's clock. */
export function liftFromRows(perRow: ReadonlyMap<string, readonly FilterCue[] | null>, windows: readonly RowWindow[]): FilterCue[] {
  const out: FilterCue[] = [];
  for (const w of windows) for (const c of perRow.get(w.rowId) ?? []) {
    const l = lift(c, w);
    if (l) out.push(l);
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/**
 * A file's stored cues with the ones inside this window replaced by `incoming` (already file-relative). Cues that belong to another part of
 * the file (an episode's neighbours in a combined file) are kept: a cue belongs to the window when its middle is inside it.
 */
export function replaceInWindow(existing: readonly FilterCue[] | null, w: RowWindow, incoming: readonly FilterCue[]): FilterCue[] {
  const lo = w.fileOffset;
  const hi = w.fileOffset + w.length;
  const keep = (existing ?? []).filter((c) => {
    const mid = (c.startSeconds + c.endSeconds) / 2;
    return mid < lo || mid >= hi;
  });
  return [...keep, ...incoming].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/** Whether two lists hold the same cues. By value: the database hands a cue back with its fields in a different order than it was built. */
export const sameCues = (a: readonly FilterCue[] | null, b: readonly FilterCue[] | null): boolean => {
  const key = (c: FilterCue) => [c.startSeconds, c.endSeconds, c.category, c.severity, c.channel, c.note ?? ""].join("|");
  const x = (a ?? []).map(key);
  const y = (b ?? []).map(key);
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

/** What the player may send: cleaned, in range, and limited to the format's categories. Anything else is dropped. */
export function cleanMarks(input: unknown, durationSeconds: number): FilterCue[] {
  if (!Array.isArray(input)) return [];
  const out: FilterCue[] = [];
  for (const raw of input.slice(0, MAX_MARKS)) {
    const c = raw as Partial<FilterCue>;
    if (!isMarkCategory(c.category) || !isFilterSeverity(c.severity)) continue;
    const start = Number(c.startSeconds);
    const end = Number(c.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start >= durationSeconds) continue;
    const note = typeof c.note === "string" ? c.note.replace(/#/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE) : "";
    out.push({
      startSeconds: round(start),
      endSeconds: round(Math.min(end, durationSeconds)),
      category: c.category,
      severity: c.severity,
      channel: c.channel === "picture" || c.channel === "sound" ? c.channel : "both",
      ...(note ? { note } : {}),
    });
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

const clock = (seconds: number) => {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
};

/**
 * The text of a Movie Content Filter file for one video file's cues. Cues of the same span share a block; only the format's own nine
 * categories are written (the others are Roam's own and would confuse other programs).
 */
export function serializeMcf(cues: readonly FilterCue[], meta: { title: string; type: "movie" | "episode"; durationSeconds: number }): string {
  const lines: string[] = ["WEBVTT MovieContentFilter 1.1.0", "", "NOTE", `TITLE ${meta.title.replace(/\s+/g, " ").trim().slice(0, 200)}`, `TYPE ${meta.type}`, "COMMENT Marked in Roam.", "", "NOTE", "START 00:00:00.000", `END ${clock(meta.durationSeconds)}`, ""];
  const blocks = new Map<string, FilterCue[]>();
  for (const c of cues) {
    if (!isMarkCategory(c.category)) continue;
    const key = `${c.startSeconds}-${c.endSeconds}`;
    blocks.set(key, [...(blocks.get(key) ?? []), c]);
  }
  for (const group of blocks.values()) {
    lines.push(`${clock(group[0].startSeconds)} --> ${clock(group[0].endSeconds)}`);
    for (const c of group) {
      const channel = c.channel === "picture" ? "=video" : c.channel === "sound" ? "=audio" : "";
      lines.push(`${c.category}=${c.severity}${channel}${c.note ? ` # ${c.note}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The file name for a video's scene file: the video's name without its extension, then ".mcf". */
export const mcfNameFor = (videoFilename: string): string => `${videoFilename.replace(/\.[^.]+$/, "")}.mcf`;
