import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { sameHost } from "@/lib/tv/form";
import { redirectTo } from "@/lib/tv/http";
import { stepItem } from "@/lib/tv/playlist-manage";
import { removeItem } from "@/lib/playlists/item-service";

/** Only a POST changes anything. Opening this address in a browser just goes to the playlist. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/change">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  return redirectTo(request, serverId && id ? `/tv/s/${serverId}/playlist/${id}` : "/tv");
}

/** Moves an item up or down, or takes it out of the playlist, then returns to the arrange page (on the same button, so it can go on). */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/change">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const action = form.get("action");
  const item = asUuid(typeof form.get("item") === "string" ? (form.get("item") as string) : "");
  if (!item || (action !== "up" && action !== "down" && action !== "remove")) return notFoundPage();
  const result = action === "remove" ? await removeItem(db, { playlistId: id, viewerId: access.scope.viewerId, itemId: item }) : await stepItem(db, access.scope, { playlistId: id, itemId: item, direction: action });
  if (!result.ok) return notFoundPage();
  return redirectTo(request, `${access.base}/playlist/${id}/arrange${action === "remove" ? "" : `?f=${item}:${action}`}`, 303); // 303: never re-send the form
}
