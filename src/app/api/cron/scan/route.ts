import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, servers } from "@/lib/db/schema";
import { scanLibrary } from "@/lib/scan/scanner";
import { cleanupOldRateLimitBuckets } from "@/lib/rate-limit";

const BATCH_SIZE = Number(process.env.CRON_SCAN_BATCH_SIZE ?? 20);

// Each scanLibrary call self-limits to ~40s; most libraries finish in well
// under a second, so a batch of 20 ordinarily fits easily inside this. If
// several large libraries land in the same batch, the platform's hard
// timeout may still cut the loop short — the untouched libraries'
// lastScanAttemptAt is simply never advanced, so they stay at the head of
// tomorrow's queue rather than being skipped or starved.
export const maxDuration = 60;

/**
 * Vercel Cron target — see vercel.json for the schedule. Vercel sends
 * `Authorization: Bearer $CRON_SECRET` on its own scheduled invocations;
 * verifying it stops anyone else from triggering a scan by hitting this URL.
 *
 * Bounded batch, not "every library" — with open sign-up the library count
 * isn't bounded, and a single invocation scanning all of them risks
 * exceeding Vercel's function time limit. Two things work together here:
 * only `connected` servers are considered (a `needs_reauth` library would
 * otherwise fail every single run forever), and the batch is ordered by
 * `lastScanAttemptAt` — updated on every attempt, success or failure, in
 * scanLibrary — not `lastScannedAt`, so a library whose scans keep failing
 * doesn't camp at the head of the queue and starve out healthy ones.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Piggybacked here rather than a separate scheduled job.
  await cleanupOldRateLimitBuckets().catch(() => {});

  const batch = await db
    .select({ id: libraries.id })
    .from(libraries)
    .innerJoin(servers, eq(libraries.serverId, servers.id))
    .where(eq(servers.boxAuthStatus, "connected"))
    .orderBy(sql`${libraries.lastScanAttemptAt} ASC NULLS FIRST`)
    .limit(BATCH_SIZE);

  const results = [];
  for (const lib of batch) {
    results.push(await scanLibrary(lib.id, "cron"));
  }

  return NextResponse.json({ results });
}
