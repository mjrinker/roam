import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { redirectTo } from "@/lib/tv/http";
import { tvPlaylist } from "@/lib/tv/playlists";
import { targetHref, tvQueueStart } from "@/lib/tv/queue";

/** Starts a playlist at its first playable item; the queue rides along in the address so each item knows what follows it. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/play">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  // The playlist must be one this profile can see on THIS server (the same gate as its page).
  if (!(await tvPlaylist(db, access.scope, id, null))) return notFoundPage();
  const first = await tvQueueStart(db, access.scope, id);
  if (!first) return notFoundPage();
  return redirectTo(request, targetHref(access.base, first, id));
}
