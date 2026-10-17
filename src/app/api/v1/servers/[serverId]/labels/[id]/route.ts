import { db } from "@/lib/db/client";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { labelWithTitles } from "@/lib/labels/queries";

/** One of the profile's labels with the titles under it that it can see, as list items. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/labels/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  if (!id) return apiNotFound();
  const { scope, serverId } = a.access;
  const label = await labelWithTitles(db, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, serverId }, id);
  if (!label) return apiNotFound();
  return apiJson({
    label: { id: label.id, name: label.name },
    items: label.titles.filter((t) => t.kind !== "ebook").map((t) => ({ type: t.kind, id: t.id, name: t.name, subtitle: t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" })),
  });
}
