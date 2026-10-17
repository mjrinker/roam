import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, musicArtists } from "@/lib/db/schema";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { checkRateLimit } from "@/lib/rate-limit";
import { artistOfSong, radioFor } from "@/lib/music/radio";
import { getArtist } from "@/lib/music/browse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * A radio for the signed-in profile: `?artist=<id>` or `?song=<id>` gives `{ ids, artistName, fromArtists }`, songs from the same library to
 * play in order (a song's radio starts with that song). The same gate as opening the artist's page; 404 for anything not visible.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const song = params.get("song");
  const artist = params.get("artist");
  if ((song === null) === (artist === null) || (song !== null && !UUID.test(song)) || (artist !== null && !UUID.test(artist))) return notFound();
  const artistId = artist ?? (await artistOfSong(db, song as string));
  if (!artistId) return notFound();
  const [row] = await db.select({ serverId: libraries.serverId }).from(musicArtists).innerJoin(libraries, eq(libraries.id, musicArtists.libraryId)).where(eq(musicArtists.id, artistId));
  if (!row) return notFound();
  const member = await getCurrentServerMember(row.serverId);
  if (!member) return notFound();
  const scope = { actor: libraryActor(member, row.serverId), viewer: member.viewer };
  if (!(await getArtist(db, { ...scope, artistId }))) return notFound();
  if (!(await checkRateLimit(member.profile.id, "music-radio", 30, 600))) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const radio = await radioFor(db, scope, { artistId, songId: song ?? undefined });
  if (!radio) return notFound();
  return NextResponse.json(radio, { headers: { "Cache-Control": "no-store" } });
}
