import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { ARRANGE_MAX, tvPlaylistCaps, visibleItems } from "@/lib/tv/playlist-manage";
import { playlistItemLabel } from "@/lib/tv/playlists";
import { arrangePage } from "@/tv/render";

/** Each item of a playlist with Move up, Move down and Remove: for whoever may change its items. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]/arrange">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const caps = await tvPlaylistCaps(db, access.scope, id);
  if (!caps || !caps.can.editItems) return notFoundPage();
  const { items, more } = await visibleItems(db, access.scope, id);
  const focus = new URL(request.url).searchParams.get("f");
  return html(
    arrangePage({
      base: access.base,
      title: caps.name,
      backHref: `${access.base}/playlist/${id}`,
      changeUrl: `${access.base}/playlist/${id}/change`,
      items: items.map((i) => ({ id: i.id, ...playlistItemLabel(i) })),
      focus: focus && /^[0-9a-f-]{36}:(up|down|remove)$/i.test(focus) ? focus : null,
      note: more ? `Only the first ${ARRANGE_MAX} are shown here.` : null,
    })
  );
}
