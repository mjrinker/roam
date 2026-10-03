import { z } from "zod";
import { db } from "@/lib/db/client";
import { badRequest, decodeCursor, encodeCursor, isUuid, limitParam, notFound, playlistDescription, playlistName, readJson, requireActor, respond, throttled } from "@/lib/playlists/http";
import { createPlaylist, listPlaylists, type ListScope } from "@/lib/playlists/service";

const createSchema = z.object({ name: playlistName, description: playlistDescription.optional() });
const cursorSchema = z.object({ updatedAt: z.string().datetime(), id: z.string().uuid() });
const SCOPES: ListScope[] = ["all", "mine", "shared", "public"];

/** The playlists this profile can see on a server: its own, ones shared with it, and public ones. */
export async function GET(request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;

  const url = new URL(request.url);
  const scope = (url.searchParams.get("scope") ?? "all") as ListScope;
  if (!SCOPES.includes(scope)) return badRequest("Unknown scope");
  const after = decodeCursor(url.searchParams.get("after"), cursorSchema);
  if (after === "invalid") return badRequest("Invalid cursor");

  const result = await listPlaylists(db, { serverId, viewerId: who.actor.viewerId, scope, limit: limitParam(url.searchParams.get("limit")), after });
  return respond(result, (v) => ({ playlists: v.playlists, nextCursor: v.nextCursor ? encodeCursor(v.nextCursor) : null }));
}

export async function POST(request: Request, ctx: RouteContext<"/api/servers/[serverId]/playlists">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return notFound();
  const who = await requireActor();
  if ("response" in who) return who.response;
  const parsed = createSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  const slow = await throttled(who.actor.accountId, "playlist_create", 30, 60);
  if (slow) return slow;

  const result = await createPlaylist(db, { serverId, viewerId: who.actor.viewerId, ...parsed.data });
  return respond(result, (p) => ({ id: p.id, name: p.name, description: p.description, visibility: p.visibility }), 201);
}
