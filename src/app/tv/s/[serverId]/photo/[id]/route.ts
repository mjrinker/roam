import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { gridCursorAt, photoView } from "@/lib/tv/data";
import { photoPreviewUrl } from "@/lib/photos/urls";
import { redirectTo } from "@/lib/tv/http";
import { photoViewPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/photo/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const fromParam = new URL(request.url).searchParams.get("from");
  const from = fromParam === "favorites" ? "favorites" : fromParam === "album" ? "album" : "timeline";
  const view = await photoView(db, access.scope, id, from);
  if (!view) return notFoundPage();
  // A clip beside the pictures plays in the video player.
  if (view.photo.kind === "movie") return redirectTo(request, `${access.base}/watch/title/${id}`);
  const suffix = from === "timeline" ? "" : `?from=${from}`;
  const hrefOf = (n: { id: string; kind: "photo" | "movie" } | null) => (n ? (n.kind === "movie" ? `${access.base}/watch/title/${n.id}` : `${access.base}/photo/${n.id}${suffix}`) : null);
  const library = `${access.base}/library/${view.photo.libraryId}`;
  // Back reopens the place you came from: the favourites, this album, or the timeline grid at this picture (the page that starts at its second).
  const after = gridCursorAt(view.photo.takenAt);
  const back =
    from === "favorites" ? `${library}?view=favorites`
    : from === "album" ? `${library}?view=albums${view.photo.folderPath ? `&path=${encodeURIComponent(view.photo.folderPath)}` : ""}`
    : `${library}${after ? `?after=${encodeURIComponent(after)}` : ""}`;
  return html(photoViewPage({ title: view.photo.name, imageUrl: photoPreviewUrl(id), prev: hrefOf(view.prev), next: hrefOf(view.next), back, position: view.photo.takenAt ? view.photo.takenAt.toISOString().slice(0, 10) : null }));
}
