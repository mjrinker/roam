import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { redirectTo } from "@/lib/tv/http";
import { tvPlaylist } from "@/lib/tv/playlists";
import { targetHref, tvQueueStart } from "@/lib/tv/queue";

/**
 * Starts a playlist at its first playable item (or, with `?shuffle=1`, at a random one in a fresh random order); the queue rides along in
 * the address so each item knows what follows it.
 */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/play">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  // The playlist must be one this profile can see on THIS server (the same gate as its page).
  if (!(await tvPlaylist(db, access.scope, id, null))) return notFoundPage();
  const shuffle = new URL(request.url).searchParams.get("shuffle") === "1" ? randomBytes(8).toString("hex") : undefined;
  const first = await tvQueueStart(db, access.scope, id, shuffle);
  if (!first) return notFoundPage();
  return redirectTo(request, targetHref(access.base, first, id, shuffle));
}
