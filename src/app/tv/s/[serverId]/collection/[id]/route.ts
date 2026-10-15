import { db } from "@/lib/db/client";
import { getCollection } from "@/lib/collections/queries";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { listPage } from "@/tv/render";

/** One collection: the titles of it this profile can see. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/collection/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const c = await getCollection(db, { actor: access.scope.actor, viewer: access.scope.viewer, collectionId: id });
  if (!c) return notFoundPage();
  const hrefOf = (t: { kind: string; id: string }) => `${access.base}/${t.kind === "movie" ? "title" : t.kind === "show" ? "show" : "book"}/${t.id}`;
  return html(
    listPage({
      base: access.base,
      title: c.name,
      subtitle: c.items.length === 1 ? "1 title" : `${c.items.length} titles`,
      backHref: `${access.base}/collections/${c.libraryId}`,
      items: c.items.map((t) => ({ href: hrefOf(t), name: t.name, meta: t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" })),
      prevHref: null,
      nextHref: null,
    })
  );
}
