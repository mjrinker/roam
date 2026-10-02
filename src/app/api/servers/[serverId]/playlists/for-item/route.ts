import { db } from "@/lib/db/client";
import { listEditablePlaylistsForItem } from "@/lib/playlists/for-item";
import { badRequest, isUuid, notFound, requireActor, respond } from "@/lib/playlists/http";

/**
 * The playlists this profile can add to, each marked with whether it already
 * contains `?titleId=` or `?episodeId=` — the data behind the "Add to playlist" menu.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists/for-item">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const titleId = url.searchParams.get("titleId") ?? undefined;
  const episodeId = url.searchParams.get("episodeId") ?? undefined;
  if (Boolean(titleId) === Boolean(episodeId) || (titleId && !isUuid(titleId)) || (episodeId && !isUuid(episodeId))) {
    return badRequest("Provide exactly one of titleId or episodeId");
  }
  return respond(await listEditablePlaylistsForItem(db, { serverId, viewerId: who.actor.viewerId, titleId, episodeId }), (rows) => ({ playlists: rows }));
}
