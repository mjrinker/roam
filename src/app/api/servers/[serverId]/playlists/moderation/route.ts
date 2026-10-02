import { db } from "@/lib/db/client";
import { isUuid, notFound, requireActor, respond } from "@/lib/playlists/http";
import { listPublicForAdmin } from "@/lib/playlists/member-service";

/** Server admins only: the server's public playlists, which are the only ones an admin may delete. */
export async function GET(_request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists/moderation">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return respond(await listPublicForAdmin(db, { serverId, viewerId: who.actor.viewerId }), (rows) => ({ playlists: rows }));
}
