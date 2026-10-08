import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { getArtist } from "@/lib/music/browse";
import { listPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/artist/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const result = await getArtist(db, { actor: access.scope.actor, viewer: access.scope.viewer, artistId: id });
  if (!result) return notFoundPage();
  return html(
    listPage({
      base: access.base,
      title: result.artist.name,
      subtitle: result.artist.libraryName,
      backHref: `${access.base}/library/${result.artist.libraryId}`,
      items: result.albums.map((a) => ({ href: `${access.base}/album/${a.id}`, name: a.name, meta: [a.year, `${a.trackCount} ${a.trackCount === 1 ? "song" : "songs"}`].filter(Boolean).join(" · "), posterUrl: a.coverUrl, square: true })),
      prevHref: null,
      nextHref: null,
    })
  );
}
