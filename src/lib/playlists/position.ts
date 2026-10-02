/** Spacing between item positions: a move almost never needs a renumber. */
export const POSITION_GAP = 1024;

/** Position for an item appended after the current last one (`null` = empty playlist). */
export function appendPosition(maxPosition: number | null): number {
  return maxPosition === null ? POSITION_GAP : maxPosition + POSITION_GAP;
}

export type MovePlan = { position: number } | { renumber: true };

/**
 * Where to put a moved item, given the position of the item it should come
 * after (`null` = move to the top) and of the row that currently follows that
 * spot — the FULL list, hidden items included, and never the moved item
 * itself. A top move uses 0 as the lower bound; a move to the end (`next` is
 * null) goes one gap past `after`. When the two bounds are less than 2 apart
 * there is no integer between them and the playlist must be renumbered.
 */
export function planMove(afterPosition: number | null, nextPosition: number | null): MovePlan {
  const lower = afterPosition ?? 0;
  if (nextPosition === null) return { position: lower + POSITION_GAP };
  if (nextPosition - lower < 2) return { renumber: true };
  return { position: Math.floor((lower + nextPosition) / 2) };
}
