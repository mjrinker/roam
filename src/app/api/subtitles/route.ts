import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { MAX_SUBTITLE_BYTES, parseSubtitleBytes } from "@/lib/subtitles/cues";
import { authorizeSubtitles, parseOwner } from "@/lib/subtitles/http";
import { addTrack, listTracks, normalizeLanguage, trackLabel } from "@/lib/subtitles/service";

/** The subtitle tracks a movie, video or episode has (what the player's menu lists). Anyone who can watch it can ask. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const owner = parseOwner(q.get("ownerKind"), q.get("ownerId"));
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner);
  if (!access.ok) return access.response;
  return NextResponse.json({ tracks: await listTracks(db, owner), canManage: access.isAdmin });
}

/** Admin: add a subtitle file from the computer (SRT, WebVTT or ASS). The file is read here and only its words and timing are kept. */
export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return NextResponse.json({ error: "Send the file as a form upload." }, { status: 415 });
  // Refuse an obviously oversize body before reading it (the real limit is checked on the bytes below).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES + 64 * 1024) return NextResponse.json({ error: "That file is too large for a subtitle file (2 MB at most)." }, { status: 413 });
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const owner = parseOwner(form.get("ownerKind"), form.get("ownerId"));
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner, { admin: true });
  if (!access.ok) return access.response;
  if (!(await checkRateLimit(access.auth.member.profile.id, "subtitle_upload", 40, 3600))) return NextResponse.json({ error: "Too many uploads: try again later." }, { status: 429 });

  const file = form.get("file");
  const language = normalizeLanguage(form.get("language"));
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a subtitle file." }, { status: 400 });
  if (!language) return NextResponse.json({ error: "Choose the language of the subtitles." }, { status: 400 });
  const hearingImpaired = form.get("hearingImpaired") === "true";

  const parsed = parseSubtitleBytes(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const added = await addTrack(db, { owner, language, label: trackLabel(form.get("label"), language, hearingImpaired), source: "upload", hearingImpaired, cues: parsed.cues, createdBy: access.auth.member.profile.id });
  if (!added.ok) return NextResponse.json({ error: added.error }, { status: added.status });
  return NextResponse.json({ ok: true, id: added.id, cues: parsed.cues.length }, { status: 201 });
}
