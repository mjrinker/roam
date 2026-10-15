import { NextResponse } from "next/server";
import { deleteExpiredDdd } from "@/lib/ddd/service";
import { db } from "@/lib/db/client";
import { purgeStale } from "@/lib/ownership/sessions";
import { runAndRecordTmdbRefresh } from "@/lib/tmdb/refresh-job";

export const maxDuration = 60;

/**
 * Vercel Cron target (see vercel.json): once a day, refreshes the oldest shared TMDB entries so nothing is kept longer than TMDB's terms
 * allow. Vercel sends `Authorization: Bearer $CRON_SECRET` on its own scheduled calls; an unset secret never matches.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const refreshed = await runAndRecordTmdbRefresh();
  // What Does the Dog Die said about a title is never kept past 30 days (their API Terms).
  const dddDeleted = await deleteExpiredDdd().catch(() => 0);
  // Players that went quiet let go of their copy (and whoever waited for it is told).
  const playersReleased = await purgeStale(db).catch(() => 0);
  return NextResponse.json({ ...refreshed, dddDeleted, playersReleased }, { headers: { "Cache-Control": "no-store" } });
}
