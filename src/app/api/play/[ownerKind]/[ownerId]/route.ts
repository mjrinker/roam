import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkDemoPlay, secondsUntilWindowRenews } from "@/lib/auth/demo-limits";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildPlayManifest } from "@/lib/player/manifest";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { parseUnsupportedCodecs } from "@/lib/player/variant-selection";
import { libraryDefaultSpeed } from "@/lib/player/library-speed";
import { listTracks } from "@/lib/subtitles/service";

// authorizeOwner covers server membership AND the profile's rating limit —
// see lib/content/access. A title blocked by the limit 404s exactly like a
// nonexistent one, so its existence isn't leaked to a restricted profile.
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]">
) {
  const { ownerKind, ownerId } = await ctx.params;
  if (ownerKind !== "title" && ownerKind !== "episode") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  // A public demo spends the owner's Box quota on every play, so it has a daily limit of its own.
  const demo = await checkDemoPlay(auth.serverId, auth.member.profile.id);
  if (!demo.ok) return NextResponse.json({ error: demo.error }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(secondsUntilWindowRenews()) } });

  const unsupportedCodecs = parseUnsupportedCodecs(new URL(request.url).searchParams.get("unsupportedCodecs"));
  const result = await buildPlayManifest(ownerKind, ownerId, auth.member.viewer.id, auth.serverId, unsupportedCodecs, isPhotoLibraryKind(auth.libraryKind));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // Subtitles ride along (not for pictures' clips, which have none). Only the track list: the words are fetched when one is chosen.
  const subtitles = isPhotoLibraryKind(auth.libraryKind) ? [] : await listTracks(db, { kind: ownerKind, id: ownerId });
  const canManageSubtitles = auth.member.role === "admin" && auth.member.viewer.role !== "limited" && !isPhotoLibraryKind(auth.libraryKind);
  return NextResponse.json({
    ...result.manifest,
    defaultRate: await libraryDefaultSpeed(auth.libraryId),
    subtitles: subtitles.map((t) => ({ id: t.id, language: t.language, label: t.label, hearingImpaired: t.hearingImpaired })),
    canManageSubtitles,
  });
}
