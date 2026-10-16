import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, musicAlbums, musicArtists } from "@/lib/db/schema";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { checkRateLimit } from "@/lib/rate-limit";
import { albumAboutFor, artistAboutFor } from "@/lib/music/about";
import { getAlbum, getArtist } from "@/lib/music/browse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * What Wikipedia says about an artist or album (and, for an artist, similar artists), for a profile that can see it. Looked up the first time
 * and kept. `kind` is `artist` or `album`. The same gate as opening the page (membership, library sharing, age limit).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/music/about/[kind]/[id]">) {
  const { kind, id } = await ctx.params;
  if ((kind !== "artist" && kind !== "album") || !UUID.test(id)) return notFound();
  const [row] =
    kind === "artist"
      ? await db.select({ serverId: libraries.serverId }).from(musicArtists).innerJoin(libraries, eq(libraries.id, musicArtists.libraryId)).where(eq(musicArtists.id, id))
      : await db.select({ serverId: libraries.serverId }).from(musicAlbums).innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId)).where(eq(musicAlbums.id, id));
  if (!row) return notFound();
  const member = await getCurrentServerMember(row.serverId);
  if (!member) return notFound();
  const scope = { actor: libraryActor(member, row.serverId), viewer: member.viewer };
  const visible = kind === "artist" ? await getArtist(db, { ...scope, artistId: id }) : await getAlbum(db, { ...scope, albumId: id });
  if (!visible) return notFound();
  if (!(await checkRateLimit(member.profile.id, "music-about", 60, 600))) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const about = kind === "artist" ? await artistAboutFor(db, scope, id) : await albumAboutFor(db, id);
  if (!about) return notFound(); // lookups are off for this library
  return NextResponse.json(about, { headers: { "Cache-Control": "private, max-age=600" } });
}
