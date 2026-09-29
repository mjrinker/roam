import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildPlayManifest } from "@/lib/player/manifest";
import { parseUnsupportedCodecs } from "@/lib/player/variant-selection";

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

  const unsupportedCodecs = parseUnsupportedCodecs(new URL(request.url).searchParams.get("unsupportedCodecs"));
  const result = await buildPlayManifest(ownerKind, ownerId, auth.member.viewer.id, auth.serverId, unsupportedCodecs);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.manifest);
}
