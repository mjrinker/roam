import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { canSeeLibrary, libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { libraries, viewerLibrarySpeeds } from "@/lib/db/schema";
import { isValidSpeed } from "@/lib/player/speed";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * The signed-in profile's own starting speed (0.25 to 3) for a library it can see, or null to go back to normal speed. It applies to
 * that profile only. Anything the profile can't see (and unknown or malformed ids) is the same 404.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/libraries/[id]/my-playback-speed">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  const member = serverId ? await getCurrentServerMember(serverId) : null;
  if (!serverId || !member || !(await canSeeLibrary(db, libraryActor(member, serverId), id))) return notFound();

  const body = (await request.json().catch(() => null)) as { speed?: unknown } | null;
  if (!body || !("speed" in body) || (body.speed !== null && !isValidSpeed(body.speed))) {
    return NextResponse.json({ error: "Send speed: a number from 0.25 to 3, or null for normal speed." }, { status: 400 });
  }
  const [library] = await db.select({ kind: libraries.kind }).from(libraries).where(eq(libraries.id, id));
  if (!library) return notFound();
  // eBooks have nothing to play.
  if (library.kind === "ebooks") return NextResponse.json({ error: "eBook libraries have nothing to play." }, { status: 400 });

  const viewerId = member.viewer.id;
  if (body.speed === null) {
    await db.delete(viewerLibrarySpeeds).where(and(eq(viewerLibrarySpeeds.viewerId, viewerId), eq(viewerLibrarySpeeds.libraryId, id)));
  } else {
    await db
      .insert(viewerLibrarySpeeds)
      .values({ viewerId, libraryId: id, speed: body.speed })
      .onConflictDoUpdate({ target: [viewerLibrarySpeeds.viewerId, viewerLibrarySpeeds.libraryId], set: { speed: body.speed, updatedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
