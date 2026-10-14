/**
 * Loading and saving a film's hand-marked scenes. Where Roam can write to the video's storage (Box), the marks live in a Movie Content Filter
 * file beside each video file, the one source of truth, and are read back into the database straight away. Where it can't (the other
 * providers' connections are read-only), they are kept in the database. Either way they act from the next play.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FilterCue } from "@/lib/content-filter/categories";
import { cleanMarks, liftFromRows, mcfNameFor, replaceInWindow, rowWindows, sameCues, serializeMcf, splitToRows } from "@/lib/content-filter/marks";
import { mediaFiles } from "@/lib/db/schema";
import { defaultVersionRows } from "@/lib/player/versions";
import { isOriginalBoxId } from "@/lib/storage/ids";
import { writeBoxSidecar } from "@/lib/storage/box-sidecar";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Row = typeof mediaFiles.$inferSelect;

/** Where a scene file can be written. */
export interface MarkWriter {
  /** Whether a scene file can be saved beside this video file. */
  writable(row: Row): boolean;
  write(serverId: string, row: Row, name: string, text: string): Promise<void>;
}

export const boxMarkWriter: MarkWriter = {
  writable: (row) => isOriginalBoxId(row.boxFileId),
  write: async (serverId, row, name, text) => {
    await writeBoxSidecar(serverId, row.boxFileId, name, text);
  },
};

export interface MarkSet {
  /** True when marks are saved as a file beside the videos (and the file's scenes are all editable); false when they are kept in Roam. */
  writesFiles: boolean;
  durationSeconds: number;
  /** The scenes the person can change, on the film's clock. */
  editable: FilterCue[];
  /** Scenes from a file Roam can't change here; shown, not editable. */
  readOnly: FilterCue[];
}

async function rowsFor(ex: Db, ownerKind: "title" | "episode", ownerId: string, version: string | null): Promise<Row[]> {
  const all = await ex
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId), isNull(mediaFiles.variantOfMediaFileId)))
    .orderBy(asc(mediaFiles.versionLabel), asc(mediaFiles.partIndex));
  return version === null ? defaultVersionRows(all) : all.filter((r) => r.versionLabel === version);
}

/** The marks for a film's files (one version), or null when it isn't ready (a file's length is unknown) or has none. */
export async function loadMarks(ex: Db, ownerKind: "title" | "episode", ownerId: string, version: string | null, writer: MarkWriter): Promise<MarkSet | null> {
  const rows = await rowsFor(ex, ownerKind, ownerId, version);
  const windows = rowWindows(rows);
  if (rows.length === 0 || windows.length === 0) return null;
  const writesFiles = rows.every((r) => writer.writable(r));
  const fileCues = liftFromRows(new Map(rows.map((r) => [r.id, r.contentCues])), windows);
  const marked = liftFromRows(new Map(rows.map((r) => [r.id, r.markedCues])), windows);
  const durationSeconds = windows.reduce((s, w) => s + w.length, 0);
  return writesFiles ? { writesFiles, durationSeconds, editable: fileCues, readOnly: [] } : { writesFiles, durationSeconds, editable: marked, readOnly: fileCues };
}

export type SaveMarksResult = { ok: true; marks: MarkSet; filesWritten: number } | { ok: false; error: "not_ready" };

/** Replaces the editable marks for a film's files with `cues` (on the film's clock). Throws if a file can't be written, leaving that file as it was. */
export async function saveMarks(
  ex: Db,
  opts: { serverId: string; ownerKind: "title" | "episode"; ownerId: string; version: string | null; cues: unknown; writer: MarkWriter }
): Promise<SaveMarksResult> {
  const rows = await rowsFor(ex, opts.ownerKind, opts.ownerId, opts.version);
  const windows = rowWindows(rows);
  if (rows.length === 0 || windows.length === 0) return { ok: false, error: "not_ready" };
  const durationSeconds = windows.reduce((s, w) => s + w.length, 0);
  const incoming = splitToRows(cleanMarks(opts.cues, durationSeconds), windows);
  const writesFiles = rows.every((r) => opts.writer.writable(r));
  let filesWritten = 0;
  for (const row of rows) {
    const w = windows.find((x) => x.rowId === row.id)!;
    const mine = incoming.get(row.id) ?? [];
    if (writesFiles) {
      const next = replaceInWindow(row.contentCues, w, mine);
      if (sameCues(row.contentCues, next)) continue;
      const text = serializeMcf(next, { title: row.filename.replace(/\.[^.]+$/, ""), type: opts.ownerKind === "title" ? "movie" : "episode", durationSeconds: row.durationSeconds ?? w.length });
      await opts.writer.write(opts.serverId, row, mcfNameFor(row.filename), text);
      filesWritten++;
      // The file is the truth, and it now says this; the database follows at once rather than at the next scan.
      await ex.update(mediaFiles).set({ contentCues: next.length > 0 ? next : null }).where(eq(mediaFiles.id, row.id));
    } else {
      const next = replaceInWindow(row.markedCues, w, mine);
      if (sameCues(row.markedCues, next)) continue;
      await ex.update(mediaFiles).set({ markedCues: next.length > 0 ? next : null }).where(eq(mediaFiles.id, row.id));
    }
  }
  const marks = await loadMarks(ex, opts.ownerKind, opts.ownerId, opts.version, opts.writer);
  return { ok: true, marks: marks!, filesWritten };
}
