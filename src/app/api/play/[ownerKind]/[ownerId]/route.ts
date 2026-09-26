import { NextResponse } from "next/server";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForOwner } from "@/lib/auth/resolve-server";
import { buildPlayManifest } from "@/lib/player/manifest";

// Any member of the server that owns this title/episode can play it — the
// server is resolved server-side from the owner id (globally unique,
// never reused across tenants), never trusted from the client, so this
// can't be spoofed by a signed-in member of a DIFFERENT server.
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]">
) {
  const { ownerKind, ownerId } = await ctx.params;
  if (ownerKind !== "title" && ownerKind !== "episode") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const serverId = await resolveServerIdForOwner(ownerKind, ownerId);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const member = await getCurrentServerMember(serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await buildPlayManifest(ownerKind, ownerId, member.profile.id, serverId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.manifest);
}
