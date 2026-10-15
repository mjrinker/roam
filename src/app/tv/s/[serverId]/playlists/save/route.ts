import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { addTargetToPlaylist } from "@/lib/tv/add-target";
import { createPlaylist, NAME_MAX, patchPlaylist } from "@/lib/playlists/service";
import { findAddableTarget } from "@/lib/playlists/items";
import { messagePage } from "@/tv/render";
import { targetFrom } from "../../add/route";

/** Only a POST changes anything. Opening this address in a browser just goes to the playlists. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlists/save">) {
  const serverId = asUuid((await ctx.params).serverId);
  return redirectTo(request, serverId ? `/tv/s/${serverId}/playlists` : "/tv");
}

/** Makes a playlist (adding what was being added, if anything) or renames one. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlists/save">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const name = (field("name") ?? "").trim().slice(0, NAME_MAX);
  if (!name) return redirectTo(request, `${access.base}/playlists`, 303);
  const playlist = asUuid(field("playlist") ?? "");
  const target = targetFrom(field);
  const viewerId = access.scope.viewerId;
  const back = safeBack(access.base, field("back"));

  if (playlist) {
    const r = await patchPlaylist(db, { playlistId: playlist, viewerId, name });
    if (!r.ok) return html(messagePage("Couldn't rename it", "That playlist can't be changed.", { href: `${access.base}/playlists`, label: "Back" }), 404);
    return redirectTo(request, `${access.base}/playlist/${playlist}`, 303);
  }
  // Something to add is checked before the playlist exists, so a refused target doesn't leave an empty playlist behind.
  if (target && target.field !== "album" && target.field !== "artist") {
    const addable = await findAddableTarget(db, { lib: access.scope.actor, viewer: access.scope.viewer, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
    if (!addable) return notFoundPage();
  }
  const created = await createPlaylist(db, { serverId, viewerId, name });
  if (!created.ok) return html(messagePage("Couldn't make it", "That didn't work. Try again.", { href: `${access.base}/playlists`, label: "Back" }), created.status === 404 ? 404 : 400);
  if (target) return addTargetToPlaylist(viewerId, { playlistId: created.value.id, target, back });
  return redirectTo(request, `${access.base}/playlist/${created.value.id}`, 303);
}
