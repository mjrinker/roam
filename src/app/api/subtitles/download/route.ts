import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseSubtitleBytes } from "@/lib/subtitles/cues";
import { OpenSubtitles, OpenSubtitlesError, openSubtitlesConfig } from "@/lib/subtitles/opensubtitles";
import { authorizeSubtitles, openSubtitlesFailure, parseOwner } from "@/lib/subtitles/http";
import { addTrack, normalizeLanguage, trackLabel } from "@/lib/subtitles/service";

/** Admin: download one subtitle from OpenSubtitles (this uses one of the account's daily downloads) and add it to the movie or episode. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const owner = parseOwner(body?.ownerKind, body?.ownerId);
  if (!body || !owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner, { admin: true });
  if (!access.ok) return access.response;

  const config = openSubtitlesConfig();
  if (!config) return openSubtitlesFailure(new OpenSubtitlesError("not_configured", "OpenSubtitles isn't set up on this server."));
  const fileId = body.fileId;
  const language = normalizeLanguage(body.language);
  if (typeof fileId !== "number" || !Number.isInteger(fileId) || fileId <= 0 || !language) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (!(await checkRateLimit(access.auth.member.profile.id, "subtitle_download", 30, 3600))) return NextResponse.json({ error: "Too many downloads: try again later." }, { status: 429 });
  const hearingImpaired = body.hearingImpaired === true;

  let downloaded;
  try {
    downloaded = await new OpenSubtitles(config).download(fileId);
  } catch (e) {
    return openSubtitlesFailure(e);
  }
  const parsed = parseSubtitleBytes(downloaded.bytes);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 502 });
  const added = await addTrack(db, { owner, language, label: trackLabel(body.label, language, hearingImpaired), source: "opensubtitles", externalId: String(fileId), hearingImpaired, cues: parsed.cues, createdBy: access.auth.member.profile.id });
  if (!added.ok) return NextResponse.json({ error: added.error }, { status: added.status });
  return NextResponse.json({ ok: true, id: added.id, cues: parsed.cues.length, remaining: downloaded.remaining, resetTime: downloaded.resetTime }, { status: 201 });
}
