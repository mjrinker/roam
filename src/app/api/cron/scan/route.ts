import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { scanLibrary } from "@/lib/scan/scanner";

/**
 * Vercel Cron target — see vercel.json for the schedule. Vercel sends
 * `Authorization: Bearer $CRON_SECRET` on its own scheduled invocations;
 * verifying it stops anyone else from triggering a scan by hitting this URL.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allLibraries = await db.select({ id: libraries.id }).from(libraries);
  const results = [];
  for (const lib of allLibraries) {
    results.push(await scanLibrary(lib.id, "cron"));
  }

  return NextResponse.json({ results });
}
