import { db } from "@/lib/db/client";
import { getCollection } from "@/lib/collections/queries";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import type { ApiItem } from "@/lib/api/v1-shapes";

/** One collection and the titles of it this profile can see, as list items (open each with `…/titles/{id}`). */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/collections/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  if (!id) return apiNotFound();
  const c = await getCollection(db, { actor: a.access.scope.actor, viewer: a.access.scope.viewer, collectionId: id });
  if (!c) return apiNotFound();
  const items: ApiItem[] = c.items.map((t) => ({ type: t.kind, id: t.id, name: t.name, subtitle: t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" }));
  return apiJson({ collection: { id: c.id, name: c.name, kind: c.kind, libraryId: c.libraryId, posterUrl: c.posterUrl }, items });
}
