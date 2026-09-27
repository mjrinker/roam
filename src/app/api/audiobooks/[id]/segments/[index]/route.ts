import { NextResponse } from "next/server";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForOwner } from "@/lib/auth/resolve-server";
import { mintAudiobookSegmentUrl } from "@/lib/player/audiobook-manifest";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/audiobooks/[id]/segments/[index]">
) {
  const { id, index: rawIndex } = await ctx.params;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const serverId = await resolveServerIdForOwner("title", id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const member = await getCurrentServerMember(serverId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await mintAudiobookSegmentUrl(id, index, serverId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.value);
}
