import { audioFragment, audioInit, audioTrack, fragmentRange, readSamples, samplesOf } from "@/lib/media-tracks/mp4-tracks";
import { tracksOf } from "@/lib/media-tracks/service";
import { PRIVATE_CACHE, trackAccess, trackFailure } from "@/lib/media-tracks/http";
import { NextResponse } from "next/server";

/**
 * One audio track of a file as fragmented MP4 for the player's Media Source: `init` first, then pieces 0, 1, 2... each a stretch of
 * FRAGMENT_SECONDS of sound. Only that track's own bytes are read from storage.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]/tracks/[fileId]/audio/[track]/[piece]">) {
  const { ownerKind, ownerId, fileId, track: rawTrack, piece } = await ctx.params;
  const trackIndex = Number(rawTrack);
  const n = piece === "init" ? -1 : Number(piece);
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 63 || !Number.isInteger(n) || n < -1 || n > 100_000) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await trackAccess(ownerKind, ownerId, fileId);
  if (!access.ok) return access.response;
  try {
    const { tracks, fetchRange } = await tracksOf(access.serverId, access.file);
    const track = audioTrack(tracks, trackIndex);
    if (!track) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/mp4", ...PRIVATE_CACHE } });
    if (n === -1) return body(audioInit(track));
    const samples = samplesOf(track);
    const [from, to] = fragmentRange(samples, track.timescale, n);
    if (to <= from) return new Response(null, { status: 204, headers: PRIVATE_CACHE });
    return body(audioFragment(samples, from, to, await readSamples(fetchRange, samples, from, to), n + 1));
  } catch (err) {
    return trackFailure(err);
  }
}
