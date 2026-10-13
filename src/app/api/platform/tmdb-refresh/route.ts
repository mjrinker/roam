import { NextResponse } from "next/server";
import { getPlatformAdmin } from "@/lib/platform/guard";
import { runAndRecordTmdbRefresh } from "@/lib/tmdb/refresh-job";

export const maxDuration = 60;

/** Platform admin: runs the TMDB refresh now (the same pass the daily job does), and says what it did. */
export async function POST() {
  if (!(await getPlatformAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await runAndRecordTmdbRefresh(), { headers: { "Cache-Control": "no-store" } });
}
