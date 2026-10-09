import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
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
  return html(
    listPage({
      base: access.base,
      title: result.playlist.name,
      subtitle: [result.playlist.ownerName, result.playlist.description].filter(Boolean).join(" · ") || null,
      backHref: `${access.base}/playlists`,
      // Play all starts at the top (a following page of a long playlist is reached with More).
      folders: after ? undefined : [{ href: `${here}/play`, name: "Play all", note: "One after another" }],
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
