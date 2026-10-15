import { db } from "@/lib/db/client";
import { getAlbum } from "@/lib/music/browse";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/** An album and its songs in order. Each song plays through `/api/audiobooks/{id}/manifest`. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/albums/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  const page = id ? await getAlbum(db, { actor: a.access.scope.actor, viewer: a.access.scope.viewer, albumId: id }) : null;
  if (!page) return apiNotFound();
  return apiJson({
    type: "album",
    id: page.album.id,
    name: page.album.name,
    year: page.album.year,
    artist: { id: page.album.artistId, name: page.album.artistName },
    coverUrl: page.album.coverUrl,
    libraryId: page.album.libraryId,
    totalSeconds: page.totalSeconds,
    tracks: page.tracks.map((t) => ({ id: t.id, name: t.name, disc: t.discNumber, number: t.trackNumber, durationSeconds: t.durationSeconds, artist: t.artist, playPath: `/api/audiobooks/${t.id}/manifest` })),
  });
}
