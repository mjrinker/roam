import { db } from "@/lib/db/client";
import { removeItem } from "@/lib/playlists/item-service";
import { isUuid, notFound, requireActor, respond } from "@/lib/playlists/http";

export async function DELETE(_request: Request, ctx: RouteContext<"/api/playlists/[id]/items/[itemId]">) {
  const { id, itemId } = await ctx.params;
  if (!isUuid(id) || !isUuid(itemId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return respond(await removeItem(db, { playlistId: id, viewerId: who.actor.viewerId, itemId }), () => ({ ok: true }));
}
