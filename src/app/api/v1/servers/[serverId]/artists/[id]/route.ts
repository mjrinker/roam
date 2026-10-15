import { db } from "@/lib/db/client";
import { getArtist } from "@/lib/music/browse";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/** An artist and their albums. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/artists/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  const page = id ? await getArtist(db, { actor: a.access.scope.actor, viewer: a.access.scope.viewer, artistId: id }) : null;
  if (!page) return apiNotFound();
  return apiJson({
    type: "artist",
    id: page.artist.id,
    name: page.artist.name,
    libraryId: page.artist.libraryId,
    albums: page.albums.map((al) => ({ type: "album", id: al.id, name: al.name, subtitle: al.year ? String(al.year) : null, posterUrl: al.coverUrl, square: true, trackCount: al.trackCount })),
  });
}
