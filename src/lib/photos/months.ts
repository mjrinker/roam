/**
 * Grouping a newest-first run of photos under headings, at three zoom levels (day, month, year). A photo's
 * time is wall-clock-as-UTC (see lib/scan/exif), so every grouping reads it in UTC: a photo taken at 23:50 on
 * the 31st stays in that month, whatever time zone the viewer is in. Pure, so the page and tests share it.
 */
export type ZoomLevel = "day" | "month" | "year";
export const ZOOM_LEVELS: readonly ZoomLevel[] = ["day", "month", "year"];

export interface MonthGroup<T> {
  /** "2024-03-30" (day), "2024-03" (month), "2024" (year), or "undated". */
  key: string;
  label: string;
  items: T[];
}

const labels = {
  day: new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }),
  month: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  year: new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "UTC" }),
};

function parse(takenAt: string | null): Date | null {
  if (!takenAt) return null;
  const d = new Date(takenAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function groupKey(takenAt: string | null, level: ZoomLevel): string {
  const d = parse(takenAt);
  if (!d) return "undated";
  const y = d.getUTCFullYear();
  if (level === "year") return String(y);
  const m = `${y}-${pad(d.getUTCMonth() + 1)}`;
  return level === "month" ? m : `${m}-${pad(d.getUTCDate())}`;
}

export function groupLabel(takenAt: string | null, level: ZoomLevel): string {
  const d = parse(takenAt);
  return d ? labels[level].format(d) : "Undated";
}

export const monthKey = (takenAt: string | null) => groupKey(takenAt, "month");
export const monthLabel = (takenAt: string | null) => groupLabel(takenAt, "month");

/** Consecutive items with the same key share a group; a group split across two pages of results is one group. */
export function groupItems<T extends { takenAt: string | null }>(items: readonly T[], level: ZoomLevel): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  for (const item of items) {
    const key = groupKey(item.takenAt, level);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: groupLabel(item.takenAt, level), items: [item] });
  }
  return groups;
}

export const groupByMonth = <T extends { takenAt: string | null }>(items: readonly T[]) => groupItems(items, "month");

/** Month names for the scrubber's floating label. */
export function bucketLabel(key: string): string {
  if (key === "undated") return "Undated";
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? labels.month.format(new Date(Date.UTC(+m[1], +m[2] - 1, 1))) : key;
}

export interface ScrubberMark {
  key: string;
  /** Where it sits along the rail, 0 (newest) to 1 (oldest). */
  at: number;
  /** A year label, only where a new year begins and there is room for it. */
  year: string | null;
}

/**
 * Where the scrubber's year labels go. Buckets are laid out evenly (not by how many photos each holds),
 * so the rail stays usable when one month has thousands. Labels closer than `minGap` (a fraction of the
 * rail) to the previous one are dropped.
 */
export function scrubberMarks(keys: readonly string[], minGap = 0.045): ScrubberMark[] {
  const n = keys.length;
  let lastLabelAt = -1;
  let lastYear = "";
  return keys.map((key, i) => {
    const at = n <= 1 ? 0 : i / (n - 1);
    const year = key === "undated" ? null : key.slice(0, 4);
    let label: string | null = null;
    if (year && year !== lastYear) {
      lastYear = year;
      if (lastLabelAt < 0 || at - lastLabelAt >= minGap) {
        label = year;
        lastLabelAt = at;
      }
    }
    return { key, at, year: label };
  });
}

/**
 * Whether a month can be scrolled to in place, or must be loaded afresh. The loaded photos are one unbroken
 * run; a month is complete from its newest photo only if something newer sits above its first loaded photo
 * (so nothing of it is missing above), or the very top of the library is loaded (`prev` is null). A month
 * that starts the loaded run while newer photos are still to load would show partly, so it is loaded again.
 */
export function canScrollInPlace(items: readonly { takenAt: string | null }[], hasNewerToLoad: boolean, key: string): boolean {
  const first = items.findIndex((i) => groupKey(i.takenAt, "month") === key);
  return first > 0 || (first === 0 && !hasNewerToLoad);
}

/** Which bucket a position along the rail (0..1) lands on. */
export function bucketAt(fraction: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
}
