/**
 * Fetches TMDB's details (once, for every server) for every matched movie and show whose shared entry doesn't exist yet: what a library
 * scan does a batch at a time, run here all at once. Safe to re-run.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-tmdb-cache.ts
 */
import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, titles, tmdbEntries } from "@/lib/db/schema";
import { backfillCast } from "@/lib/content/cast-backfill";

async function main() {
  // A title stamped as asked before the shared entries existed has to be asked again.
  await db.update(titles).set({ castAttemptedAt: null }).where(and(isNotNull(titles.tmdbId), inArray(titles.kind, ["movie", "show"])));
  const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(inArray(libraries.kind, ["movies", "shows"]));
  for (const lib of libs) {
    let batches = 0;
    while (await backfillCast(lib.id, Date.now() + 10 * 60_000)) batches++;
    console.log(`${lib.name}: done (${batches + 1} batch${batches ? "es" : ""})`);
  }
  const entries = await db.select({ id: tmdbEntries.tmdbId }).from(tmdbEntries);
  console.log(`${entries.length} shared TMDB entries.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
