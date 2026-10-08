import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries, musicAlbums } from "@/lib/db/schema";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Admin only: ask for an album to be looked up on MusicBrainz again (on the next scan). Everyone else, and unknown or
 * malformed ids, get the same 404, so this never confirms an album exists.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/albums/[id]/rematch">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const [album] = await db
    .select({ libraryId: musicAlbums.libraryId, lookup: libraries.musicLookup })
    .from(musicAlbums)
    .innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId))
    .where(eq(musicAlbums.id, id));
  if (!album) return notFound();
  const serverId = await resolveServerIdForLibrary(album.libraryId);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();
  if (!album.lookup) return NextResponse.json({ error: "Turn on the MusicBrainz look-up for this library first." }, { status: 409 });

  await db
    .update(musicAlbums)
    .set({ matchStatus: "pending", matchAttempts: 0, matchAttemptedAt: null, matchedTrackCount: null })
    .where(eq(musicAlbums.id, id));
  return NextResponse.json({ ok: true });
}
