import { NextResponse } from "next/server";
import { textCues, textTrack } from "@/lib/media-tracks/mp4-tracks";
import { tracksOf } from "@/lib/media-tracks/service";
import { PRIVATE_CACHE, trackAccess, trackFailure } from "@/lib/media-tracks/http";

/** The words of one subtitle track inside a file, as `{ cues: [[start, end, text], ...] }` in the file's own time. */
export async function GET(_request: Request, ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]/tracks/[fileId]/text/[track]">) {
  const { ownerKind, ownerId, fileId, track: rawTrack } = await ctx.params;
  const trackIndex = Number(rawTrack);
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 63) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await trackAccess(ownerKind, ownerId, fileId);
  if (!access.ok) return access.response;
  try {
    const { tracks, fetchRange } = await tracksOf(access.serverId, access.file);
    const track = textTrack(tracks, trackIndex);
    if (!track) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ cues: await textCues(fetchRange, track) }, { headers: PRIVATE_CACHE });
  } catch (err) {
    return trackFailure(err);
  }
}
