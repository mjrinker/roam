import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { tvPlaylists } from "@/lib/tv/playlists";
import { playlistsPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/playlists">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const lists = await tvPlaylists(db, access.scope);
  return html(
    playlistsPage({
      base: access.base,
      lists: lists.map((p) => ({ href: `${access.base}/playlist/${p.id}`, name: p.name, note: `${p.itemCount} ${p.itemCount === 1 ? "item" : "items"}${p.ownerName ? ` · ${p.ownerName}` : ""}` })),
    })
  );
}
