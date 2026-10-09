import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { authorizeSubtitles, isUuid } from "@/lib/subtitles/http";
import { deleteTrack, getTrack } from "@/lib/subtitles/service";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** A track's words and timing, for the player to draw. Anyone who can watch what it belongs to can read it. */
export async function GET(_request: Request, ctx: RouteContext<"/api/subtitles/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const track = await getTrack(db, id);
  if (!track) return notFound();
  const access = await authorizeSubtitles(track.owner);
  if (!access.ok) return access.response;
  return NextResponse.json({ id: track.id, language: track.language, label: track.label, cues: track.cues }, { headers: { "Cache-Control": "private, max-age=3600" } });
}

/** Admin: remove a track. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/subtitles/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const track = await getTrack(db, id);
  if (!track) return notFound();
  const access = await authorizeSubtitles(track.owner, { admin: true });
  if (!access.ok) return access.response;
  return (await deleteTrack(db, id)) ? NextResponse.json({ ok: true }) : notFound();
}
