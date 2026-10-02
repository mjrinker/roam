import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, decodeCursor, encodeCursor, isUuid, limitParam, notFound, requireActor, respond } from "@/lib/playlists/http";
import { listPublicForAdmin } from "@/lib/playlists/member-service";

const cursorSchema = z.object({ name: z.string(), id: z.string().uuid() });

/** Server admins only: the server's public playlists, which are the only ones an admin may delete. */
export async function GET(request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists/moderation">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const after = decodeCursor(url.searchParams.get("after"), cursorSchema);
  if (after === "invalid") return badRequest("Invalid cursor");
  const result = await listPublicForAdmin(db, { serverId, viewerId: who.actor.viewerId, limit: limitParam(url.searchParams.get("limit")), after });
  return respond(result, (v) => ({ playlists: v.playlists, nextCursor: v.nextCursor ? encodeCursor(v.nextCursor) : null }));
}
