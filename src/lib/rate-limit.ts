import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimitBuckets } from "@/lib/db/schema";

/**
 * Fixed-window rate limiter backed by Postgres, so it works correctly
 * across serverless instances without a new external dependency (Redis,
 * Upstash, etc.). Only exists because sign-up is now open to anyone —
 * every caller of this exists to bound what an unvetted new account can do.
 *
 * `windowStart` is computed deterministically as
 * floor(now/windowSeconds)*windowSeconds, not relative to "now" per call —
 * concurrent requests within the same window must land on the identical
 * value to actually collide on one row; a per-request-relative timestamp
 * would give each request its own row and silently defeat the limit.
 *
 * The increment is a single atomic INSERT ... ON CONFLICT DO UPDATE, not
 * read-then-write — two concurrent requests both reading count=19 under a
 * limit of 20 would otherwise both think they're under it and both proceed.
 */
export async function checkRateLimit(
  profileId: string,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartSeconds = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const windowStart = new Date(windowStartSeconds * 1000);

  const [{ count: newCount }] = await db
    .insert(rateLimitBuckets)
    .values({ profileId, bucket, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [
        rateLimitBuckets.profileId,
        rateLimitBuckets.bucket,
        rateLimitBuckets.windowStart,
      ],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });

  return newCount <= limit;
}

/** Deletes rate-limit rows older than a day — piggybacked on the daily cron run. */
export async function cleanupOldRateLimitBuckets() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.windowStart} < ${cutoff}`);
}
