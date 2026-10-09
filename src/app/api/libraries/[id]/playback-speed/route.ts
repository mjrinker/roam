import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { isValidSpeed } from "@/lib/player/speed";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Admin only: the speed (0.25 to 3) a library's videos, audio and books start at, or null to go back to normal speed. Everyone else
 * (and unknown or malformed ids) gets the same 404, so this never confirms a library exists.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/libraries/[id]/playback-speed">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();

  const body = (await request.json().catch(() => null)) as { speed?: unknown } | null;
  if (!body || !("speed" in body) || (body.speed !== null && !isValidSpeed(body.speed))) {
    return NextResponse.json({ error: "Send speed: a number from 0.25 to 3, or null for normal speed." }, { status: 400 });
  }
  const [library] = await db.select({ kind: libraries.kind }).from(libraries).where(eq(libraries.id, id));
  if (!library) return notFound();
  // eBooks have nothing to play.
  if (library.kind === "ebooks") return NextResponse.json({ error: "eBook libraries have nothing to play." }, { status: 400 });
  await db.update(libraries).set({ defaultPlaybackSpeed: body.speed }).where(eq(libraries.id, id));
  return NextResponse.json({ ok: true });
}
