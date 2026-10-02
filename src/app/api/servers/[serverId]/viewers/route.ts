import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, decodeCursor, encodeCursor, isUuid, limitParam, notFound, requireActor, respond } from "@/lib/playlists/http";
import { sharePicker } from "@/lib/playlists/member-service";

const cursorSchema = z.object({ name: z.string(), id: z.string().uuid() });

/** Profiles this one may share a playlist with: only id, name and avatar are ever returned. */
export async function GET(request: Request, ctx: RouteContext<"/api/servers/[serverId]/viewers">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const after = decodeCursor(url.searchParams.get("after"), cursorSchema);
  if (after === "invalid") return badRequest("Invalid cursor");
  const result = await sharePicker(db, { serverId, viewerId: who.actor.viewerId, limit: limitParam(url.searchParams.get("limit")), after });
  return respond(result, (v) => ({ viewers: v.viewers, nextCursor: v.nextCursor ? encodeCursor(v.nextCursor) : null }));
}
