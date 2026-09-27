import { NextResponse } from "next/server";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForOwner } from "@/lib/auth/resolve-server";
import { buildAudiobookManifest } from "@/lib/player/audiobook-manifest";

// The owning server is resolved from the book's id, never trusted from the
// client, so a member of a DIFFERENT server can't play it.
export async function GET(_request: Request, ctx: RouteContext<"/api/audiobooks/[id]/manifest">) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForOwner("title", id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const member = await getCurrentServerMember(serverId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await buildAudiobookManifest(id, member.viewer.id, serverId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.value);
}
