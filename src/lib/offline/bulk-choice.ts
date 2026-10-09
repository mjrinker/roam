/** Choosing one download version per item for a whole selection, and what that adds up to. Pure. */
import type { DownloadOption, DownloadOptions } from "./options";

export type QualityTarget = { kind: "best" } | { kind: "smallest" } | { kind: "height"; height: number };

/** The option that fits the target: the best, the smallest picture, or the closest in height (the lower one when two are equally close). */
export function pickOption(options: readonly DownloadOption[], target: QualityTarget): DownloadOption | null {
  if (options.length === 0) return null;
  if (target.kind === "best") return options[0]; // the server lists them best first
  const sized = options.filter((o) => o.height !== null);
  if (sized.length === 0) return options[0]; // nothing to compare by (audio): the only choice
  if (target.kind === "smallest") return sized.reduce((low, o) => ((o.height as number) < (low.height as number) ? o : low));
  let best = sized[0];
  for (const o of sized) {
    const gap = Math.abs((o.height as number) - target.height);
    const bestGap = Math.abs((best.height as number) - target.height);
    if (gap < bestGap || (gap === bestGap && (o.height as number) < (best.height as number))) best = o;
  }
  return best;
}

/** The resolutions the selection offers, highest first, each named as the picker names them (for choosing a target). */
export function qualityChoices(items: readonly DownloadOptions[]): { height: number; name: string }[] {
  const byHeight = new Map<number, string>();
  for (const item of items) for (const o of item.options) if (o.height !== null && !byHeight.has(o.height)) byHeight.set(o.height, o.name.replace(/ \(.*\)$/, ""));
  return [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([height, name]) => ({ height, name }));
}

export interface BulkSummary {
  count: number;
  /** The chosen versions' sizes added up (items with an unknown size count nothing here and are counted in `unknownSizes`). */
  totalBytes: number;
  unknownSizes: number;
}

export function summarizeBulk(items: readonly DownloadOptions[], target: QualityTarget): BulkSummary {
  let totalBytes = 0;
  let unknownSizes = 0;
  for (const item of items) {
    const o = pickOption(item.options, target);
    if (!o) continue;
    if (o.sizeBytes === null) unknownSizes++;
    else totalBytes += o.sizeBytes;
  }
  return { count: items.length, totalBytes, unknownSizes };
}
