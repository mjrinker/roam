import { db } from "@/lib/db/client";
import { listCollections } from "@/lib/collections/queries";
import { tvLibrary } from "@/lib/tv/data";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/** The collections of a movies, shows or audiobooks library that this profile can see: `{ collections: [{ id, name, kind, count, posterUrl }] }`. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/libraries/[libraryId]/collections">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const libraryId = asId(params.libraryId);
  if (!libraryId) return apiNotFound();
  const library = await tvLibrary(db, a.access.scope, libraryId);
  if (!library || library.style !== "grid") return apiNotFound();
  return apiJson({ collections: await listCollections(db, { actor: a.access.scope.actor, viewer: a.access.scope.viewer, libraryId }) });
}
