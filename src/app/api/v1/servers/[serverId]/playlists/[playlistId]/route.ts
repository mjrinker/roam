import { db } from "@/lib/db/client";
import { parsePlaylistCursor, playlistCursorParam, tvPlaylist } from "@/lib/tv/playlists";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { playlistApiItem } from "@/lib/api/playlist-items";

/** One playlist and a page of the items this profile may see in it, in order. `?after=` is the `next` of the page before. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/playlists/[playlistId]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.playlistId);
  if (!id) return apiNotFound();
  const after = parsePlaylistCursor(new URL(request.url).searchParams.get("after"));
  if (after === "bad") return apiNotFound();
  const result = await tvPlaylist(db, a.access.scope, id, after);
  if (!result) return apiNotFound();
  return apiJson({
    playlist: result.playlist,
    items: result.items.flatMap((item) => {
      const shaped = playlistApiItem(item);
      return shaped ? [shaped] : [];
    }),
    next: result.nextCursor ? playlistCursorParam(result.nextCursor) : null,
  });
}
