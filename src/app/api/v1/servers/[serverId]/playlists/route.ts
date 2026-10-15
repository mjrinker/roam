import { db } from "@/lib/db/client";
import { tvPlaylists } from "@/lib/tv/playlists";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/** The playlists this profile owns, was given, or that are shared on the server, newest first. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/playlists">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  return apiJson({ playlists: await tvPlaylists(db, a.access.scope) });
}
