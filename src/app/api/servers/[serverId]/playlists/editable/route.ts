import { db } from "@/lib/db/client";
import { listEditablePlaylists } from "@/lib/playlists/for-item";
import { isUuid, notFound, requireActor, respond } from "@/lib/playlists/http";

/** The playlists this profile can add to (owner, or an editor): the choices for "add an album / an artist to a playlist". */
export async function GET(_request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists/editable">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return respond(await listEditablePlaylists(db, { serverId, viewerId: who.actor.viewerId }), (rows) => ({ playlists: rows }));
}
