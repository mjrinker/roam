import { db } from "@/lib/db/client";
import { photoPreviewUrl } from "@/lib/photos/urls";
import { photoView } from "@/lib/tv/data";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";

/**
 * One picture (or video clip) of a photo library with the items either side of it, in the order the place it was opened from shows them
 * (`?from=timeline` newest first, the default; `favorites`; or `album`, the folder it is in). `imagePath` is the large picture, to be fetched
 * with the same token; `prev` and `next` are `{ type: "photo"|"clip", id }` or null. A clip plays like any video (`/api/play/title/{id}`).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/photos/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  if (!id) return apiNotFound();
  const fromParam = new URL(request.url).searchParams.get("from");
  const from = fromParam === "favorites" ? "favorites" : fromParam === "album" ? "album" : "timeline";
  const view = await photoView(db, a.access.scope, id, from);
  if (!view) return apiNotFound();
  const ref = (n: { id: string; kind: "photo" | "movie" } | null) => (n ? { type: n.kind === "movie" ? "clip" : "photo", id: n.id } : null);
  const p = view.photo;
  return apiJson({
    id: p.id,
    type: p.kind === "movie" ? "clip" : "photo",
    name: p.name,
    takenAt: p.takenAt ? p.takenAt.toISOString() : null,
    favorite: p.favorite,
    libraryId: p.libraryId,
    folderPath: p.folderPath,
    imagePath: p.kind === "photo" ? photoPreviewUrl(p.id) : null,
    prev: ref(view.prev),
    next: ref(view.next),
  });
}
