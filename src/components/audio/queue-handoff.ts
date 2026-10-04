/** A book started from a playlist queue, remembered so the queue continues when the book ends. */
export interface BookQueue {
  playlistId: string;
  itemId: string;
}

/**
 * Whether finishing a queued book should carry the listener on to the next entry. Not
 * when they've since started another playlist's queue (that page now owns the flow).
 */
export function shouldContinueQueue(currentSearch: string, queue: BookQueue): boolean {
  const other = new URLSearchParams(currentSearch).get("playlist");
  return other === null || other === queue.playlistId;
}
