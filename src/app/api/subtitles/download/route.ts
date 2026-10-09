import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseSubtitleBytes } from "@/lib/subtitles/cues";
import { OpenSubtitles, OpenSubtitlesError, openSubtitlesConfig } from "@/lib/subtitles/opensubtitles";
import { authorizeSubtitles, openSubtitlesFailure, parseOwner } from "@/lib/subtitles/http";

/**
 * Download one subtitle from OpenSubtitles (this uses one of the server account's daily downloads) and send back its words and timing.
 * Nothing is kept: it is for this viewing only.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const owner = parseOwner(body?.ownerKind, body?.ownerId);
  if (!body || !owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner);
  if (!access.ok) return access.response;

  const config = openSubtitlesConfig();
  if (!config) return openSubtitlesFailure(new OpenSubtitlesError("not_configured", "OpenSubtitles isn't set up on this server."));
  const fileId = body.fileId;
  if (typeof fileId !== "number" || !Number.isInteger(fileId) || fileId <= 0) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (!(await checkRateLimit(access.auth.member.profile.id, "subtitle_download", 30, 3600))) return NextResponse.json({ error: "Too many downloads: try again later." }, { status: 429 });

  let downloaded;
  try {
    downloaded = await new OpenSubtitles(config).download(fileId);
  } catch (e) {
    return openSubtitlesFailure(e);
  }
  const parsed = parseSubtitleBytes(downloaded.bytes);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 502 });
  return NextResponse.json({ cues: parsed.cues, remaining: downloaded.remaining, resetTime: downloaded.resetTime });
}
