import { NextResponse } from "next/server";
import { checkDemoPlay, secondsUntilWindowRenews } from "@/lib/auth/demo-limits";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildAudiobookManifest } from "@/lib/player/audiobook-manifest";
import { viewerLibrarySpeed } from "@/lib/player/library-speed";
import { needsHeartbeat, ownershipGate } from "@/lib/ownership/gate";

// authorizeOwner covers server membership AND the profile's rating limit —
// a book blocked by the limit 404s exactly like a nonexistent one.
export async function GET(_request: Request, ctx: RouteContext<"/api/audiobooks/[id]/manifest">) {
  const { id } = await ctx.params;

  const auth = await authorizeOwner("title", id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  const demo = await checkDemoPlay(auth.serverId, auth.member.profile.id);
  if (!demo.ok) return NextResponse.json({ error: demo.error }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(secondsUntilWindowRenews()) } });

  const blocked = await ownershipGate({ viewerId: auth.member.viewer.id, accountId: auth.member.profile.id }, "title", id, { take: true });
  if (blocked) return blocked;

  const result = await buildAudiobookManifest(id, auth.member.viewer.id, auth.serverId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ...result.value, heartbeat: await needsHeartbeat("title", id), libraryId: auth.libraryId, defaultRate: await viewerLibrarySpeed(auth.member.viewer.id, auth.libraryId) });
}
