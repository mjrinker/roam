/**
 * Seeds the watch statistics from where every profile left off in what it has watched, once, so the statistics are not empty on the day they
 * start. It is an estimate: a finished movie, show episode or audiobook counts its whole length and a partly watched one counts how far it got,
 * all on the day it was last played (the progress saved from then on is counted properly, as it happens). Counted per household, never per
 * profile. Safe to run again: it only fills days that have nothing recorded yet for that household and title.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-watch-activity.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/backfill-watch-activity.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const rows = await db.execute(sql`
    SELECT l.server_id, v.account_id, (w.updated_at AT TIME ZONE 'UTC')::date AS day, t.id AS title_id,
           sum(CASE WHEN w.finished THEN coalesce(w.duration_seconds, w.position_seconds) ELSE w.position_seconds END)::int AS seconds
    FROM watch_state w
    JOIN viewers v ON v.id = w.viewer_id
    LEFT JOIN episodes e ON w.owner_kind = 'episode' AND e.id = w.owner_id
    LEFT JOIN seasons sn ON sn.id = e.season_id
    JOIN titles t ON t.id = CASE WHEN w.owner_kind = 'episode' THEN sn.title_id ELSE w.owner_id END
    JOIN libraries l ON l.id = t.library_id
    JOIN server_members sm ON sm.server_id = l.server_id AND sm.profile_id = v.account_id
    WHERE t.kind IN ('movie', 'show', 'audiobook')
    GROUP BY l.server_id, v.account_id, (w.updated_at AT TIME ZONE 'UTC')::date, t.id
    HAVING sum(CASE WHEN w.finished THEN coalesce(w.duration_seconds, w.position_seconds) ELSE w.position_seconds END) > 0`);
  const list = rows as unknown as { server_id: string; account_id: string; day: string; title_id: string; seconds: number }[];
  const total = list.reduce((n, r) => n + r.seconds, 0);
  console.log(`${list.length} household-days, ${(total / 3600).toFixed(1)} hours${dry ? " (dry run)" : ""}.`);
  if (dry) process.exit(0);
  let added = 0;
  for (const r of list) {
    const res = await db.execute(sql`INSERT INTO watch_activity (server_id, account_id, day, title_id, seconds) VALUES (${r.server_id}::uuid, ${r.account_id}::uuid, ${String(r.day).slice(0, 10)}::date, ${r.title_id}::uuid, ${r.seconds}) ON CONFLICT DO NOTHING RETURNING seconds`);
    added += (res as unknown as unknown[]).length;
  }
  console.log(`Added ${added} of them.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
