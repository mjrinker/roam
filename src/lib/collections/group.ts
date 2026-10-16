/** Showing a collection as one tile in a list: it takes the place of the first of its titles in the list's order, and the rest are left out. */
import type { CollectionCard } from "@/lib/collections/queries";

export type Tile<T> = { kind: "title"; item: T } | { kind: "collection"; card: CollectionCard; firstId: string };

export function groupTiles<T extends { id: string }>(items: readonly T[], index: { cards: Record<string, CollectionCard>; byTitle: Record<string, string> }): Tile<T>[] {
  const out: Tile<T>[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const collectionId = index.byTitle[item.id];
    const card = collectionId ? index.cards[collectionId] : undefined;
    if (!card) {
      out.push({ kind: "title", item });
    } else if (!placed.has(card.id)) {
      placed.add(card.id);
      out.push({ kind: "collection", card, firstId: item.id });
    }
  }
  return out;
}
