/** Loading and saving a film's hand-marked intro, recap, credits and preview times. Kept in Roam's database (there is no file format for them). */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { markRowsFor } from "@/lib/content-filter/save-marks";
import { rowWindows } from "@/lib/content-filter/marks";
import { mediaFiles } from "@/lib/db/schema";
import type { SkipSegment } from "@/lib/skipdb/client";
import { cleanSkipMarks, replaceSkipWindow, skipMarksFromRows, splitSkipMarks } from "@/lib/skipdb/marks";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface SkipMarkSet {
  durationSeconds: number;
  marks: SkipSegment[];
}

/** The marks for a film's files (one version), or null when it isn't ready. */
export async function loadSkipMarks(ex: Db, ownerKind: "title" | "episode", ownerId: string, version: string | null): Promise<SkipMarkSet | null> {
  const rows = await markRowsFor(ex, ownerKind, ownerId, version);
  const windows = rowWindows(rows);
  if (rows.length === 0 || windows.length === 0) return null;
  return { durationSeconds: windows.reduce((s, w) => s + w.length, 0), marks: skipMarksFromRows(rows) };
}

/** Replaces the film's marks with `marks` (on the film's clock; one per kind). */
export async function saveSkipMarks(ex: Db, opts: { ownerKind: "title" | "episode"; ownerId: string; version: string | null; marks: unknown }): Promise<SkipMarkSet | null> {
  const rows = await markRowsFor(ex, opts.ownerKind, opts.ownerId, opts.version);
  const windows = rowWindows(rows);
  if (rows.length === 0 || windows.length === 0) return null;
  const duration = windows.reduce((s, w) => s + w.length, 0);
  const incoming = splitSkipMarks(cleanSkipMarks(opts.marks, duration), windows);
  for (const row of rows) {
    const w = windows.find((x) => x.rowId === row.id)!;
    const next = replaceSkipWindow(row.skipMarks, w, incoming.get(row.id) ?? []);
    if (JSON.stringify(next) === JSON.stringify(row.skipMarks ?? [])) continue;
    await ex.update(mediaFiles).set({ skipMarks: next.length > 0 ? next : null }).where(eq(mediaFiles.id, row.id));
  }
  return loadSkipMarks(ex, opts.ownerKind, opts.ownerId, opts.version);
}
