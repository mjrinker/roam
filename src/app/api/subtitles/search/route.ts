import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { OpenSubtitles, OpenSubtitlesError, openSubtitlesConfig } from "@/lib/subtitles/opensubtitles";
import { authorizeSubtitles, openSubtitlesFailure, parseOwner } from "@/lib/subtitles/http";
import { normalizeLanguage, searchTarget } from "@/lib/subtitles/service";

/** Look for subtitles on OpenSubtitles for a movie or episode the viewer can watch, in the languages asked for (comma separated, "en,es"). */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const owner = parseOwner(q.get("ownerKind"), q.get("ownerId"));
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await authorizeSubtitles(owner);
  if (!access.ok) return access.response;

  const config = openSubtitlesConfig();
  if (!config) return openSubtitlesFailure(new OpenSubtitlesError("not_configured", "OpenSubtitles isn't set up on this server. You can still load a subtitle file from your device."));
  const languages = (q.get("languages") ?? "en").split(",").map(normalizeLanguage).filter((l): l is string => !!l).slice(0, 6);
  if (languages.length === 0) return NextResponse.json({ error: "Choose at least one language." }, { status: 400 });
  if (!(await checkRateLimit(access.auth.member.profile.id, "subtitle_search", 40, 600))) return NextResponse.json({ error: "Too many searches: try again in a few minutes." }, { status: 429 });

  const target = await searchTarget(db, owner);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json({ results: await new OpenSubtitles(config).search({ ...target, languages }) });
  } catch (e) {
    return openSubtitlesFailure(e);
  }
}
