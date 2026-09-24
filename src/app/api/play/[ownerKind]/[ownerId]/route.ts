import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth/guards";
import { buildPlayManifest } from "@/lib/player/manifest";

// All authenticated profiles (admin + viewer) can play any title/episode
// today — there's no per-user library entitlement model yet, just
// invite-gated access to the whole server. See requireProfile() in
// lib/auth/guards.
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/play/[ownerKind]/[ownerId]">
) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { ownerKind, ownerId } = await ctx.params;
  if (ownerKind !== "title" && ownerKind !== "episode") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await buildPlayManifest(ownerKind, ownerId, profile.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.manifest);
}
