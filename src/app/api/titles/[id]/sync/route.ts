import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForTitle } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { refuseUnlessExternalMetadata } from "@/lib/libraries/kind";
import { syncSingleTitle } from "@/lib/scan/scanner";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";

// Matches the per-library scan budget — a single title is normally much
// faster, but a show with many seasons/episodes can still take a while.
export const maxDuration = 60;

/** Admin-triggered resync of one title's Box folder, without rescanning the whole library. */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/titles/[id]/sync">
) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForTitle(id);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const refused = await refuseUnlessExternalMetadata(db, id);
  if (refused) return refused;

  try {
    const result = await syncSingleTitle(id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
      return NextResponse.json(
        { error: "This server's Box connection needs to be reconnected." },
        { status: 424 }
      );
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
