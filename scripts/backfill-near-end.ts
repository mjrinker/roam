/**
 * Marks as watched the movies and episodes that were left with only the credits to go (see isNearEnd in lib/player/timeline), so they leave
 * Continue Watching and the next episode comes up in Up Next. New saves do this by themselves; this catches what was saved before.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-near-end.ts          (a count, changes nothing)
 *   npx tsx --env-file=.env.local scripts/backfill-near-end.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

const NEAR = sql`w.finished = false AND w.duration_seconds >= 120 AND w.duration_seconds - w.position_seconds <= LEAST(300, w.duration_seconds * 0.2)
  AND (w.owner_kind = 'episode' OR EXISTS (SELECT 1 FROM titles t WHERE t.id = w.owner_id AND t.kind = 'movie'))`;

(async () => {
  const rows = (await db.execute(sql`SELECT w.owner_kind, count(*)::int AS n FROM watch_state w WHERE ${NEAR} GROUP BY 1`)) as unknown as { owner_kind: string; n: number }[];
  console.log("near the end:", rows.map((r) => `${r.n} ${r.owner_kind}s`).join(", ") || "none");
  if (process.argv.includes("--apply") && rows.length) {
    await db.execute(sql`UPDATE watch_state w SET finished = true WHERE ${NEAR}`);
    console.log("marked watched");
  }
  process.exit(0);
})();
