import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth/resolve-server";
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

  const auth = await authorizeOwner("title", id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  const result = await mintAudiobookSegmentUrl(id, index, auth.serverId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.value);
}
