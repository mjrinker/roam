import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { tvQueueStart } from "@/lib/tv/queue";
import { tvPlaylistCaps } from "@/lib/tv/playlist-manage";
import { parsePlaylistCursor, playlistCursorParam, playlistItemHref, playlistItemLabel, tvPlaylist } from "@/lib/tv/playlists";
import { listPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlist/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const after = parsePlaylistCursor(new URL(request.url).searchParams.get("after"));
  if (after === "bad") return notFoundPage();
  const result = await tvPlaylist(db, access.scope, id, after);
  if (!result) return notFoundPage();
  const here = `${access.base}/playlist/${id}`;
  // What this profile may do to it: change its items, rename it, delete it (sharing stays on the web).
  const caps = after ? null : await tvPlaylistCaps(db, access.scope, id);
  const play = after || !(await tvQueueStart(db, access.scope, id)) ? [] : [{ href: `${here}/play`, name: "Play all", note: "One after another" }, { href: `${here}/play?shuffle=1`, name: "Shuffle", note: "In a random order" }];
  const manage = [
    ...(caps?.can.editItems ? [{ href: `${here}/arrange`, name: "Arrange", note: "Order and remove" }] : []),
    ...(caps?.can.rename ? [{ href: `${access.base}/playlists/name?playlist=${id}&name=${encodeURIComponent(result.playlist.name)}&back=${encodeURIComponent(here)}`, name: "Rename" }] : []),
    ...(caps?.can.delete ? [{ href: `${here}/delete`, name: "Delete" }] : []),
  ];
  return html(
    listPage({
      base: access.base,
      title: result.playlist.name,
      subtitle: [result.playlist.ownerName, result.playlist.description].filter(Boolean).join(" · ") || null,
      backHref: `${access.base}/playlists`,
      // Play all starts at the top (a following page of a long playlist is reached with More).
      actions: [...play, ...manage].length ? [...play, ...manage] : undefined,
      items: result.items.flatMap((item) => {
        const href = playlistItemHref(item, id);
        const label = playlistItemLabel(item);
        return href ? [{ href: `${access.base}${href}`, name: label.name, meta: label.meta, posterUrl: item.posterUrl, square: item.titleKind === "audiobook" }] : [];
      }),
      prevHref: null,
      nextHref: result.nextCursor ? `${here}?after=${encodeURIComponent(playlistCursorParam(result.nextCursor))}` : null,
    })
  );
}
