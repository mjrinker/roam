import { NextResponse } from "next/server";
import { describeTracks } from "@/lib/media-tracks/mp4-tracks";
import { tracksOf } from "@/lib/media-tracks/service";
import { PRIVATE_CACHE, trackAccess, trackFailure } from "@/lib/media-tracks/http";

/** The audio and subtitle tracks inside one file of a movie or episode (a part, or its browser-friendly copy). */
export async function GET(_request: Request, ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]/tracks/[fileId]">) {
  const { ownerKind, ownerId, fileId } = await ctx.params;
  const access = await trackAccess(ownerKind, ownerId, fileId);
  if (!access.ok) return access.response;
  try {
    const { tracks } = await tracksOf(access.serverId, access.file);
    return NextResponse.json(describeTracks(tracks), { headers: PRIVATE_CACHE });
  } catch (err) {
    return trackFailure(err);
  }
}
