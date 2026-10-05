/**
 * Grouping a newest-first run of photos under month headings. A photo's time is wall-clock-as-UTC
 * (see lib/scan/exif), so the month is read in UTC too: a photo taken at 23:50 on the 31st stays in
 * that month whatever time zone the viewer is in. Pure, so the page and tests share it.
 */
export interface MonthGroup<T> {
  /** "2024-03", or "undated". */
  key: string;
  label: string;
  items: T[];
}

const formatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function monthKey(takenAt: string | null): string {
  if (!takenAt) return "undated";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "undated";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(takenAt: string | null): string {
  if (!takenAt) return "Undated";
  const d = new Date(takenAt);
  return Number.isNaN(d.getTime()) ? "Undated" : formatter.format(d);
}

/** Consecutive items with the same month share a group; a month split across two pages of results is one group. */
export function groupByMonth<T extends { takenAt: string | null }>(items: readonly T[]): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  for (const item of items) {
    const key = monthKey(item.takenAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: monthLabel(item.takenAt), items: [item] });
  }
  return groups;
}
