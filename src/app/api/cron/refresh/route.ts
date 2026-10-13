import { NextResponse } from "next/server";
import { runTmdbRefresh } from "@/lib/tmdb/refresh-job";

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
  return NextResponse.json(await runTmdbRefresh(), { headers: { "Cache-Control": "no-store" } });
}
