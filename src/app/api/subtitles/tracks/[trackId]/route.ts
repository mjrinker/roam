import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { subtitleTracks } from "@/lib/db/schema";
import { createStorageForServer } from "@/lib/storage/server-storage";
import { MAX_SUBTITLE_BYTES, parseSubtitleBytes } from "@/lib/subtitles/cues";
import { authorizeSubtitles } from "@/lib/subtitles/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

async function load(trackId: string) {
  if (!UUID.test(trackId)) return null;
  const [row] = await db.select().from(subtitleTracks).where(eq(subtitleTracks.id, trackId)).limit(1);
  if (!row || (row.ownerKind !== "title" && row.ownerKind !== "episode")) return null;
  return { row, owner: { kind: row.ownerKind, id: row.ownerId } as const };
}

/** One kept subtitle track as `{ cues }` (for anyone who may play the title): a file beside the video is read from storage now. */
export async function GET(_request: Request, ctx: RouteContext<"/api/subtitles/tracks/[trackId]">) {
  const found = await load((await ctx.params).trackId);
  if (!found) return notFound();
  const access = await authorizeSubtitles(found.owner);
  if (!access.ok) return access.response;
  const { row } = found;
  let cues = row.cues;
  if (row.source === "file") {
    if (!row.storageFileId) return notFound();
    try {
      const size = Math.min(row.sizeBytes ?? MAX_SUBTITLE_BYTES, MAX_SUBTITLE_BYTES);
      const bytes = new Uint8Array(await createStorageForServer(access.auth.serverId).fetchByteRange(row.storageFileId, 0, Math.max(0, size - 1)));
      const parsed = parseSubtitleBytes(bytes);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 });
      cues = parsed.cues;
    } catch {
      return NextResponse.json({ error: "The subtitle file couldn't be read right now." }, { status: 502 });
    }
  }
  return NextResponse.json({ cues: cues ?? [] }, { headers: { "Cache-Control": "private, max-age=3600" } });
}

/** Takes a saved subtitle track away (the server's admin only; a file beside the video goes by deleting the file). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/subtitles/tracks/[trackId]">) {
  const found = await load((await ctx.params).trackId);
  if (!found) return notFound();
  const access = await authorizeSubtitles(found.owner);
  if (!access.ok) return access.response;
  const { member } = access.auth;
  if (member.role !== "admin" || member.viewer.role === "limited") return NextResponse.json({ error: "Only the server's admin can do that." }, { status: 403 });
  if (found.row.source !== "saved") return NextResponse.json({ error: "That is a file beside the video: delete the file instead." }, { status: 409 });
  await db.delete(subtitleTracks).where(eq(subtitleTracks.id, found.row.id));
  return NextResponse.json({ ok: true });
}
