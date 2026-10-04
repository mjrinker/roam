import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { isVideoRating, setVideoLibraryRating } from "@/lib/libraries/video-rating";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Admin only: rate a video library (and so every video in it). Everyone else (non-members, viewers,
 * limited profiles, unknown or malformed ids) gets the same 404, so this never confirms a library exists.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/libraries/[id]/rating">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();

  const body = (await request.json().catch(() => null)) as { rating?: unknown } | null;
  if (!body || !("rating" in body) || !isVideoRating(body.rating)) {
    return NextResponse.json({ error: "Choose one of the ratings." }, { status: 400 });
  }
  const result = await setVideoLibraryRating(db, id, body.rating);
  if (!result.ok) {
    return result.reason === "not_found"
      ? notFound()
      : NextResponse.json({ error: "Only video libraries have a library rating." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
