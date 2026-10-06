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

/** The UTC period a bucket key stands for, or null if the key isn't one of this level's (or is "undated"). */
export function bucketRange(level: ZoomLevel, key: string): { from: Date; to: Date } | null {
  const valid = (y: number) => y >= 1826 && y <= 9998;
  if (level === "year") {
    const m = /^(\d{4})$/.exec(key);
    return m && valid(+m[1]) ? { from: new Date(Date.UTC(+m[1], 0, 1)), to: new Date(Date.UTC(+m[1] + 1, 0, 1)) } : null;
  }
  if (level === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m && valid(+m[1]) && +m[2] >= 1 && +m[2] <= 12 ? { from: new Date(Date.UTC(+m[1], +m[2] - 1, 1)), to: new Date(Date.UTC(+m[1], +m[2], 1)) } : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m || !valid(+m[1]) || +m[2] < 1 || +m[2] > 12 || +m[3] < 1) return null;
  const from = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return from.getUTCMonth() === +m[2] - 1 ? { from, to: new Date(from.getTime() + 86_400_000) } : null; // Feb 30 rolls over: not a day
}

/** Which bucket a position along the rail (0..1) lands on. */
export function bucketAt(fraction: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
}

// ── Reserving space for blocks that aren't loaded yet ──
// Every block (a day, month or year) is laid out up front at its exact height, from its photo count alone, so
// scrolling anywhere is just scrolling: nothing is inserted above you and nothing is swapped under you as
// photos arrive. Tiles are square and the grid's gaps are fixed, so the height is simple arithmetic.

export const TILE_GAP = 4;
/** A block's heading (a fixed height, so it never changes a block's size) and the space under it. */
export const HEADING_HEIGHT = 36;
export const HEADING_GAP = 12;
/** The space between blocks. */
export const BLOCK_GAP = 24;

/**
 * How many tiles fit across, per zoom level and viewport width. Mirrors the grid's responsive classes
 * (Tailwind's sm 640, md 768, lg 1024 and xl 1280), which is what makes the arithmetic below exact.
 */
export function gridColumns(zoom: ZoomLevel, viewportWidth: number): number {
  const steps = {
    day: [3, 4, 5, 6, 6],
    month: [3, 4, 5, 6, 8],
    year: [5, 7, 9, 11, 14],
  }[zoom];
  const i = viewportWidth >= 1280 ? 4 : viewportWidth >= 1024 ? 3 : viewportWidth >= 768 ? 2 : viewportWidth >= 640 ? 1 : 0;
  return steps[i];
}

export function tileSize(containerWidth: number, columns: number): number {
  return Math.max(0, (containerWidth - TILE_GAP * (columns - 1)) / columns);
}

/** The height of a block with `count` photos in a grid of `columns`, whether or not they are loaded. */
export function blockHeight(count: number, columns: number, containerWidth: number): number {
  const rows = Math.ceil(Math.max(0, count) / columns);
  const tile = tileSize(containerWidth, columns);
  const grid = rows === 0 ? 0 : rows * tile + (rows - 1) * TILE_GAP;
  return Math.round(HEADING_HEIGHT + HEADING_GAP + grid);
}
