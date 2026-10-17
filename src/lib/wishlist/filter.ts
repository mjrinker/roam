/** Which wishes the page shows: by kind, and whether those already got are included. Pure, so it is tested without the page. */
import type { WishKind } from "./rules";

export interface Filterable {
  kind: WishKind;
  status: "wanted" | "claimed" | "got";
  onServer: unknown;
}

/** A wish is "done" once it is got or is already on the server. */
export const isDone = (w: Filterable): boolean => w.status === "got" || !!w.onServer;

export function filterWishes<T extends Filterable>(items: readonly T[], opts: { kind: WishKind | "all"; showDone: boolean }): T[] {
  return items.filter((w) => (opts.kind === "all" || w.kind === opts.kind) && (opts.showDone || !isDone(w)));
}

/** How many of each kind are still wanted (not done), for the filter chips. */
export function countsByKind<T extends Filterable>(items: readonly T[]): Record<WishKind | "all", number> {
  const counts = { all: 0, movie: 0, show: 0, audiobook: 0, book: 0, album: 0, other: 0 } as Record<WishKind | "all", number>;
  for (const w of items) {
    if (isDone(w)) continue;
    counts.all++;
    counts[w.kind]++;
  }
  return counts;
}
