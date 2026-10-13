import { clearExpired, deleteUnreferencedEntries, refreshEntry, staleEntries } from "@/lib/tmdb/cache";

export interface RefreshSummary {
  refreshed: number;
  missing: number;
  failed: number;
  cleared: number;
}

/**
 * One pass of the daily TMDB refresh: forget entries no title uses, refresh the oldest ones that are past their freshness (a few at a
 * time, until the batch or the time runs out), then clear any that are past the hard limit and could not be refreshed.
 */
export async function runTmdbRefresh(opts: { limit?: number; deadline?: number; concurrency?: number } = {}): Promise<RefreshSummary> {
  const { limit = 150, deadline = Date.now() + 45_000, concurrency = 4 } = opts;
  await deleteUnreferencedEntries();
  const summary: RefreshSummary = { refreshed: 0, missing: 0, failed: 0, cleared: 0 };
  const batch = await staleEntries(limit);
  for (let i = 0; i < batch.length && Date.now() < deadline; i += concurrency) {
    const results = await Promise.all(batch.slice(i, i + concurrency).map((e) => refreshEntry(e.kind, e.tmdbId)));
    for (const r of results) summary[r]++;
  }
  summary.cleared = await clearExpired();
  return summary;
}
