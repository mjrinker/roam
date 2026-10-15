import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { lyricsFor } from "@/lib/lyrics/service";

/**
 * The lyrics of a song the profile may play: `{ synced: [{ t, text }] | null, plain, instrumental }`, or 404 when it has none (or is not a song).
 * Looked up on LRCLIB the first time and kept. Same gate as playing the song (membership, library sharing, age limit).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/lyrics/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await authorizeOwner("title", id);
  if (!auth.ok) return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  if (!(await checkRateLimit(auth.member.profile.id, "lyrics", 120, 600))) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const lyrics = await lyricsFor(db, id);
  if (!lyrics) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "private, max-age=300" } });
  return NextResponse.json(lyrics, { headers: { "Cache-Control": "private, max-age=3600" } });
}
