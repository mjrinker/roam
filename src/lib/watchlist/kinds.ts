/** What can go on a watch list. */
export const WATCHLIST_KINDS = ["movie", "show", "audiobook"] as const;
export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];
