import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { librarySources } from "@/lib/db/schema";
import { isUuid } from "@/lib/playlists/http";

/**
 * Admin: take a folder out of a library. What was found in it stays until the next scan of the library no longer sees it
 * (nothing is deleted here); the library's first folder can't be removed this way.
 */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/libraries/[id]/sources/[sourceId]">) {
  const { id, sourceId } = await ctx.params;
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId || !isUuid(sourceId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const removed = await db.delete(librarySources).where(and(eq(librarySources.id, sourceId), eq(librarySources.libraryId, id))).returning({ id: librarySources.id });
  if (removed.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
