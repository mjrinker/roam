/**
 * Fetches the billed cast from TMDB for every movie and show that has a TMDB match and no cast yet - what a library scan does a batch
 * at a time, run here all at once. Safe to re-run.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-cast.ts
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, titleCast } from "@/lib/db/schema";
import { backfillCast } from "@/lib/content/cast-backfill";

async function main() {
  const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(inArray(libraries.kind, ["movies", "shows"]));
  for (const lib of libs) {
    let batches = 0;
    while (await backfillCast(lib.id, Date.now() + 10 * 60_000)) batches++;
    console.log(`${lib.name}: done (${batches + 1} batch${batches ? "es" : ""})`);
  }
  const rows = await db.select({ id: titleCast.personId }).from(titleCast).where(eq(titleCast.position, 0));
  console.log(`${rows.length} title(s) now have a cast.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
