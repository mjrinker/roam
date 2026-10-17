import { NextResponse } from "next/server";
import { checkDemoPlay, secondsUntilWindowRenews } from "@/lib/auth/demo-limits";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildPlayManifest } from "@/lib/player/manifest";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { parseUnsupportedCodecs } from "@/lib/player/variant-selection";
import { viewerLibrarySpeed } from "@/lib/player/library-speed";
import { parseSkipParam } from "@/lib/content-filter/timeline";
import { needsHeartbeat, ownershipGate } from "@/lib/ownership/gate";
import { aimHeight } from "@/lib/player/data-saver";

// authorizeOwner covers server membership AND the profile's rating limit —
// see lib/content/access. A title blocked by the limit 404s exactly like a
// nonexistent one, so its existence isn't leaked to a restricted profile.
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]">
) {
  const { ownerKind, ownerId } = await ctx.params;
  if (ownerKind !== "title" && ownerKind !== "episode" && ownerKind !== "extra") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  // A public demo spends the owner's Box quota on every play, so it has a daily limit of its own.
  const demo = await checkDemoPlay(auth.serverId, auth.member.profile.id);
  if (!demo.ok) return NextResponse.json({ error: demo.error }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(secondsUntilWindowRenews()) } });

  // With ownership tracked: a title every owner has withdrawn, or one whose copies are all being played, doesn't play (and a play that
  // can start takes its place at once). Extras (bonus features) are only checked for withdrawal.
  const blocked = await ownershipGate({ viewerId: auth.member.viewer.id, accountId: auth.member.profile.id }, ownerKind, ownerId, { take: true });
  if (blocked) return blocked;

  const params = new URL(request.url).searchParams;
  const unsupportedCodecs = parseUnsupportedCodecs(params.get("unsupportedCodecs"));
  const heightParam = Number(params.get("height"));
  const choice = {
    version: params.get("version") !== null ? params.get("version")!.trim().toLowerCase().slice(0, 60) : null,
    // With data saver on, no higher than about 480p unless a version is asked for by name.
    preferredHeight: aimHeight(Number.isInteger(heightParam) && heightParam >= 100 && heightParam <= 5000 ? heightParam : null, auth.member.viewer.dataSaver),
    // Scenes chosen just before playing, for this play only (on top of the profile's own).
    extraSkip: parseSkipParam(params.get("skip")),
  };
  const result = await buildPlayManifest(ownerKind, ownerId, auth.member.viewer.id, auth.serverId, unsupportedCodecs, isPhotoLibraryKind(auth.libraryKind), choice);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // A server's admin (a profile that may change settings) can mark scenes while watching; the marking route checks again.
  const canMark = ownerKind !== "extra" && auth.member.role === "admin" && auth.member.viewer.role !== "limited";
  return NextResponse.json({ ...result.manifest, heartbeat: await needsHeartbeat(ownerKind, ownerId), canMark, libraryId: auth.libraryId, defaultRate: await viewerLibrarySpeed(auth.member.viewer.id, auth.libraryId) });
}
