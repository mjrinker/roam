import { db } from "@/lib/db/client";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { listWatchlist } from "@/lib/watchlist/queries";

/** This profile's watch list on the server, most recently added first. Add and remove with `PUT /api/watchlist`. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/watchlist">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  const { scope, serverId } = a.access;
  const items = await listWatchlist(db, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, serverId });
  return apiJson({
    items: items.map((r) => ({ type: r.kind, id: r.id, name: r.name, subtitle: r.year ? String(r.year) : null, posterUrl: r.posterUrl, square: r.kind === "audiobook", addedAt: r.addedAt.toISOString() })),
  });
}
