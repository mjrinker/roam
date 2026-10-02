import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, isUuid, notFound, playlistDescription, playlistName, readJson, requireActor, respond } from "@/lib/playlists/http";
import { deletePlaylist, getPlaylistDetail, patchPlaylist } from "@/lib/playlists/service";

const patchSchema = z
  .object({ name: playlistName.optional(), description: playlistDescription.optional(), visibility: z.enum(["private", "server"]).optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export async function GET(_request: Request, ctx: RouteContext<"/api/playlists/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return respond(await getPlaylistDetail(db, { playlistId: id, viewerId: who.actor.viewerId }));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/playlists/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = patchSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const result = await patchPlaylist(db, { playlistId: id, viewerId: who.actor.viewerId, ...parsed.data });
  return respond(result, (p) => ({ id: p.id, name: p.name, description: p.description, visibility: p.visibility }));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/playlists/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  return respond(await deletePlaylist(db, { playlistId: id, viewerId: who.actor.viewerId }), () => ({ ok: true }));
}
