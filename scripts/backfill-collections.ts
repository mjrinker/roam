/**
 * Finds which film series (TMDB collection) each matched movie belongs to, and builds the collections. The scan and the daily job do this a
 * little at a time; this does all of it now (one TMDB request per film whose stored entry predates collections).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-collections.ts
 */
import { db } from "@/lib/db/client";
import { catchUpCollections } from "@/lib/collections/sync";

async function main() {
  const deadline = Date.now() + 8 * 60_000;
  let rounds = 0;
  while (rounds++ < 50 && (await catchUpCollections(db, deadline)) && Date.now() < deadline) console.log(`pass ${rounds} done, more to do`);
  console.log("done");
  process.exit(0);
}
void main();
