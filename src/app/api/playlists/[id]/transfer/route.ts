import { z } from "zod";
import { db } from "@/lib/db/client";
import { transferOwnership } from "@/lib/playlists/member-service";
import { badRequest, isUuid, notFound, readJson, requireActor, respond } from "@/lib/playlists/http";

const bodySchema = z.object({ viewerId: z.string().uuid() });

export async function POST(request: Request, ctx: RouteContext<"/api/playlists/[id]/transfer">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  return respond(await transferOwnership(db, { playlistId: id, viewerId: who.actor.viewerId, targetViewerId: parsed.data.viewerId }), () => ({ ok: true }));
}
