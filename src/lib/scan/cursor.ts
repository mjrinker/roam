import type { libraries } from "@/lib/db/schema";

/**
 * Resumable-scan cursor. A scan's folder loop walks the library's top-level
 * folders in one fixed order; the cursor records the last one fully
 * processed so the next pass continues after it instead of restarting.
 * `sub` is reserved for a second level (a book inside an author folder).
 *
 * IMPORTANT: passes that start from a cursor have only seen part of the
 * library. Anything that prunes rows because they're "missing from Box" must
 * only run after a pass completes a full cycle (cursor cleared), never on a
 * partial one. Today nothing prunes titles by absence.
 */
export type ScanCursor = { folder: string; sub?: string };

// One collator for both ordering and cursor comparison, so "after the
// cursor" always means the same thing as sort order.
const collator = new Intl.Collator("en", { numeric: true });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export function sortForScan<T extends { id: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => compareNames(a.name, b.name) || a.id.localeCompare(b.id));
}

/**
 * Entries (already sorted with sortForScan) still to process: everything
 * strictly after the cursor's folder, plus the cursor's own folder first when
 * the cursor has a `sub` (that folder was only partly done).
 */
export function entriesAfterCursor<T extends { name: string }>(
  sorted: T[],
  cursor: ScanCursor | null
): T[] {
  if (!cursor) return sorted;
  return sorted.filter((e) => {
    const order = compareNames(e.name, cursor.folder);
    return order > 0 || (order === 0 && cursor.sub !== undefined);
  });
}

export type ScanPlan =
  | { mode: "full" }
  | { mode: "continue"; cursor: ScanCursor }
  | { mode: "probe-only" };

type Trigger = "manual" | "cron" | "webhook" | "resume";
type LibraryScanState = Pick<typeof libraries.$inferSelect, "scanIncomplete" | "scanCursor">;

/**
 * What a scan should do given how it was triggered and where the last one
 * stopped. Manual and webhook scans always start over. Resume/cron passes
 * continue an interrupted scan: mid-loop if there's a cursor, or straight
 * to probing if the folder loop already finished.
 */
export function planScan(trigger: Trigger, library: LibraryScanState): ScanPlan {
  if (trigger === "manual" || trigger === "webhook" || !library.scanIncomplete) {
    return { mode: "full" };
  }
  return library.scanCursor
    ? { mode: "continue", cursor: library.scanCursor }
    : { mode: "probe-only" };
}
