import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, scanRuns } from "@/lib/db/schema";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { resolveLibraryOwnerIds } from "@/lib/scan/scanner";

export interface LibraryStatusDto {
  scanning: boolean;
  titleCount: number;
  probeCounts: { pending: number; ok: number; failed: number };
  lastScannedAt: string | null;
  lastScan: {
    trigger: "manual" | "cron" | "webhook" | "resume";
    finishedAt: string | null;
    filesSeen: number;
    titlesAdded: number;
    errors: string[];
  } | null;
}

// A scan that's still running when checked this long after it started is
// almost certainly a crashed/killed invocation, not a real 40s-budgeted
// scan — treat it as stale rather than showing "scanning…" forever.
const SCAN_STALE_MS = 5 * 60 * 1000;

/** Polled by the admin library manager for a live progress readout while a scan is in flight. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/libraries/[id]/status">
) {
  const { id: libraryId } = await ctx.params;

  const serverId = await resolveServerIdForLibrary(libraryId);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [library] = await db.select().from(libraries).where(eq(libraries.id, libraryId)).limit(1);
  if (!library) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [latestRun] = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.libraryId, libraryId))
    .orderBy(desc(scanRuns.startedAt))
    .limit(1);
  const scanning =
    !!latestRun &&
    latestRun.finishedAt === null &&
    Date.now() - latestRun.startedAt.getTime() < SCAN_STALE_MS;

  const { titleIds, episodeIds } = await resolveLibraryOwnerIds(libraryId);

  const [titleProbeRows, episodeProbeRows] = await Promise.all([
    titleIds.length
      ? db
          .select({ probeStatus: mediaFiles.probeStatus, count: sql<number>`count(*)::int` })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, titleIds)))
          .groupBy(mediaFiles.probeStatus)
      : Promise.resolve([]),
    episodeIds.length
      ? db
          .select({ probeStatus: mediaFiles.probeStatus, count: sql<number>`count(*)::int` })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, episodeIds)))
          .groupBy(mediaFiles.probeStatus)
      : Promise.resolve([]),
  ]);

  const probeCounts = { pending: 0, ok: 0, failed: 0 };
  for (const row of [...titleProbeRows, ...episodeProbeRows]) {
    probeCounts[row.probeStatus as keyof typeof probeCounts] += row.count;
  }

  const body: LibraryStatusDto = {
    scanning,
    titleCount: titleIds.length,
    probeCounts,
    lastScannedAt: library.lastScannedAt?.toISOString() ?? null,
    lastScan: latestRun
      ? {
          trigger: latestRun.trigger,
          finishedAt: latestRun.finishedAt?.toISOString() ?? null,
          filesSeen: latestRun.filesSeen,
          titlesAdded: latestRun.titlesAdded,
          errors: latestRun.errors ?? [],
        }
      : null,
  };
  return NextResponse.json(body);
}
