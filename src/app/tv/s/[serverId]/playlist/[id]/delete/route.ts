import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { tvPlaylistCaps } from "@/lib/tv/playlist-manage";
import { deletePlaylist } from "@/lib/playlists/service";
import { messagePage, postButton, tvDocument } from "@/tv/render";

/** "Delete this playlist?" with a Yes (a POST) and a way back. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/delete">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const caps = await tvPlaylistCaps(db, access.scope, id);
  if (!caps || !caps.can.delete) return notFoundPage();
  const here = `${access.base}/playlist/${id}`;
  return html(
    tvDocument({
      title: "Delete this playlist?",
      body:
        `<div class="page"><div class="top"><span class="brand">ROAM</span></div><h1>Delete &ldquo;${caps.name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}&rdquo;?</h1><p class="msg">This can't be undone. The movies, shows and music in it are not deleted.</p>` +
        `<div class="row"><a class="btn primary" data-f data-autofocus data-back href="${here}">No, keep it</a>${postButton(`${here}/delete`, "Yes, delete it")}</div></div>`,
    })
  );
}

export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/delete">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const result = await deletePlaylist(db, { playlistId: id, viewerId: access.scope.viewerId });
  if (!result.ok) return html(messagePage("Couldn't delete it", "That playlist can't be deleted by this profile.", { href: `${access.base}/playlists`, label: "Back" }), 404);
  return redirectTo(request, `${access.base}/playlists`, 303);
}
