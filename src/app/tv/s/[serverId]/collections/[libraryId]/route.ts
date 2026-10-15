import { db } from "@/lib/db/client";
import { listCollections } from "@/lib/collections/queries";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { tvLibrary } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { listPage } from "@/tv/render";

/** A movies or shows library's collections (film series and ones an admin made). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/collections/[libraryId]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const libraryId = asUuid(params.libraryId);
  if (!serverId || !libraryId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const library = await tvLibrary(db, access.scope, libraryId);
  if (!library || library.style !== "grid") return notFoundPage();
  const cards = await listCollections(db, { actor: access.scope.actor, viewer: access.scope.viewer, libraryId });
  return html(
    listPage({
      base: access.base,
      title: `${library.name}: collections`,
      backHref: `${access.base}/library/${libraryId}`,
      items: cards.map((c) => ({ href: `${access.base}/collection/${c.id}`, name: c.name, meta: c.count === 1 ? "1 title" : `${c.count} titles`, posterUrl: c.posterUrl })),
      prevHref: null,
      nextHref: null,
    })
  );
}
