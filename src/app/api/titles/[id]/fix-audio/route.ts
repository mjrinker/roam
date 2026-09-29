import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForTitle } from "@/lib/auth/resolve-server";
import { MAX_REMUX_ATTEMPTS, probeCodecsForTitle, queueRemux } from "@/lib/remux/remux-pass";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";

// Only reads a handful of codec headers before queueing; the remux itself
// runs in its own invocation (see /api/remux/run).
export const maxDuration = 60;

/**
 * Admin-triggered: makes a browser-friendly (AAC audio) copy of this title's
 * files whose audio Chrome/Firefox can't decode. Safe to click repeatedly —
 * a repeat click recovers a stuck/failed job rather than doing nothing.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/titles/[id]/fix-audio">) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForTitle(id);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await probeCodecsForTitle(id);
    const result = await queueRemux(id);

    if (result.flagged === 0) return NextResponse.json({ status: "not-needed", ...result });
    if (result.queued > 0) return NextResponse.json({ status: "queued", ...result });
    if (result.exhausted > 0) {
      return NextResponse.json(
        {
          status: "exhausted",
          error: `Gave up after ${MAX_REMUX_ATTEMPTS} attempts. Check the server logs, then delete the failed copy (if any) in Box and resync.`,
          ...result,
        },
        { status: 409 }
      );
    }
    if (result.alreadyDone >= result.flagged) return NextResponse.json({ status: "already-done", ...result });
    // Jobs already in flight (the trigger was re-fired anyway).
    return NextResponse.json({ status: "in-progress", ...result });
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
