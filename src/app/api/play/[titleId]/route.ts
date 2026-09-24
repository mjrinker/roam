import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles, watchState } from "@/lib/db/schema";
import { boxProvider } from "@/lib/storage/box";
import { getCurrentProfile } from "@/lib/auth/guards";
import type { PlayManifest, PlaySegment } from "@/lib/player/types";

// All authenticated profiles (admin + viewer) can play any title today —
// there's no per-user library entitlement model yet, just invite-gated
// access to the whole server. See requireProfile() in lib/auth/guards.
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/play/[titleId]">
) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { titleId } = await ctx.params;

  const [title] = await db
    .select()
    .from(titles)
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!title) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const segmentRows = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId)))
    .orderBy(asc(mediaFiles.partIndex));

  const incompleteSegment = segmentRows.find((s) => s.durationSeconds == null);
  if (segmentRows.length === 0 || incompleteSegment) {
    return NextResponse.json(
      { error: "Title is not ready to play yet (still scanning/probing)" },
      { status: 409 }
    );
  }

  let cursor = 0;
  let earliestExpiry: Date | null = null;
  const segments: PlaySegment[] = [];
  for (const [index, row] of segmentRows.entries()) {
    const { url, expiresAt } = await boxProvider.getStreamingUrl(row.boxFileId);
    if (!earliestExpiry || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
    segments.push({
      index,
      url,
      durationSeconds: row.durationSeconds!,
      startSeconds: cursor,
    });
    cursor += row.durationSeconds!;
  }

  const [existingState] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profile.id),
        eq(watchState.ownerKind, "title"),
        eq(watchState.ownerId, titleId)
      )
    )
    .limit(1);

  const manifest: PlayManifest = {
    titleId,
    durationSeconds: cursor,
    segments,
    resumeSeconds: existingState?.finished ? 0 : existingState?.positionSeconds ?? 0,
    expiresAt: (earliestExpiry ?? new Date(Date.now() + 60_000)).toISOString(),
  };

  return NextResponse.json(manifest);
}
