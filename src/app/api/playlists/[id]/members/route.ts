import { z } from "zod";
import { db } from "@/lib/db/client";
import { addMember, changeMemberRole, listMembers, removeMember } from "@/lib/playlists/member-service";
import { badRequest, decodeCursor, encodeCursor, isUuid, limitParam, notFound, readJson, requireActor, respond, throttled } from "@/lib/playlists/http";

const roleSchema = z.enum(["editor", "sharer", "viewer"]);
const shareSchema = z.object({ viewerId: z.string().uuid(), role: roleSchema });
const cursorSchema = z.object({ createdAt: z.string(), id: z.string().uuid() });

export async function GET(request: Request, ctx: RouteContext<"/api/playlists/[id]/members">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const url = new URL(request.url);
  const after = decodeCursor(url.searchParams.get("after"), cursorSchema);
  if (after === "invalid") return badRequest("Invalid cursor");
  const result = await listMembers(db, { playlistId: id, viewerId: who.actor.viewerId, limit: limitParam(url.searchParams.get("limit")), after });
  return respond(result, (v) => ({ members: v.members, nextCursor: v.nextCursor ? encodeCursor(v.nextCursor) : null }));
}

/** Share with a profile (or, for the owner, change an existing share). */
export async function POST(request: Request, ctx: RouteContext<"/api/playlists/[id]/members">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = shareSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const slow = await throttled(who.actor.accountId, "playlist_share", 120, 60);
  if (slow) return slow;
  return respond(await addMember(db, { playlistId: id, viewerId: who.actor.viewerId, targetViewerId: parsed.data.viewerId, role: parsed.data.role }), (v) => v, 201);
}

/** Owner only: change the role on an existing share. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/playlists/[id]/members">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = shareSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  return respond(await changeMemberRole(db, { playlistId: id, viewerId: who.actor.viewerId, targetViewerId: parsed.data.viewerId, role: parsed.data.role }));
}

/** Remove a share. Without `?viewerId=` it removes the caller's own share ("leave playlist"). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/playlists/[id]/members">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const target = new URL(request.url).searchParams.get("viewerId") ?? who.actor.viewerId;
  if (!isUuid(target)) return notFound();
  return respond(await removeMember(db, { playlistId: id, viewerId: who.actor.viewerId, targetViewerId: target }), () => ({ ok: true }));
}
