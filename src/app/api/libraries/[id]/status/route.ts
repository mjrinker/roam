import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, scanRuns, titles } from "@/lib/db/schema";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";
import { resolveLibraryOwnerIds } from "@/lib/scan/scanner";

export interface LibraryStatusDto {
  scanning: boolean;
  titleCount: number;
  probeCounts: { pending: number; ok: number; failed: number };
  lastScannedAt: string | null;
  /** Folder-loop progress of the scan in flight; null once folders are done or when idle. */
  folderProgress: { done: number; total: number } | null;
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
const CONTINUING_GRACE_MS = 45 * 1000;

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
  const running =
    !!latestRun &&
    latestRun.finishedAt === null &&
    Date.now() - latestRun.startedAt.getTime() < SCAN_STALE_MS;
  // Between chained passes there's a brief moment with no run in flight;
  // count that as still scanning. If the chain broke, this lapses after
  // CONTINUING_GRACE_MS and the admin can rescan.
  const continuing =
    library.scanIncomplete &&
    !!latestRun?.finishedAt &&
    Date.now() - latestRun.finishedAt.getTime() < CONTINUING_GRACE_MS;
  const scanning = running || continuing;

  // A video library can hold tens of thousands of titles, so it is counted with joins in SQL; the
  // other kinds list their ids (bounded by how many titles and episodes a library realistically has).
  const isVideo = isFileTreeLibraryKind(library.kind);
  const { titleIds, episodeIds } = isVideo ? { titleIds: [] as string[], episodeIds: [] as string[] } : await resolveLibraryOwnerIds(libraryId);
  const videoTitleCount = isVideo
    ? (await db.select({ n: sql<number>`count(*)::int` }).from(titles).where(eq(titles.libraryId, libraryId)))[0].n
    : 0;

  const [titleProbeRows, episodeProbeRows] = await Promise.all([
    isVideo
      ? db
          .select({ probeStatus: mediaFiles.probeStatus, count: sql<number>`count(*)::int` })
          .from(mediaFiles)
          .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(titles.id, mediaFiles.ownerId)))
          .where(eq(titles.libraryId, libraryId))
          .groupBy(mediaFiles.probeStatus)
      : titleIds.length
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
    titleCount: isVideo ? videoTitleCount : titleIds.length,
    probeCounts,
    lastScannedAt: library.lastScannedAt?.toISOString() ?? null,
    folderProgress:
      scanning && library.scanFoldersDone < library.scanFoldersTotal
        ? { done: library.scanFoldersDone, total: library.scanFoldersTotal }
        : null,
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
