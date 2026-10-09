import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { watchInfo } from "@/lib/tv/data";
import { html, json } from "@/lib/tv/http";
import { parseQueueContext, targetHref, tvQueueNext } from "@/lib/tv/queue";
import { watchConfig, watchPage } from "@/tv/render";

/** How long the "Up next" countdown runs. */
const UP_NEXT_SECONDS = 10;

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/watch/[kind]/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id || (params.kind !== "title" && params.kind !== "episode")) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const info = await watchInfo(db, access.scope, params.kind, id);
  if (!info) return notFoundPage();
  const b = info.back;
  const back =
    b.kind === "title" ? `${access.base}/title/${b.id}`
    : b.kind === "show" ? `${access.base}/show/${b.id}?season=${b.season}`
    : b.kind === "photoGrid" ? photoGridBack(access.base, b, new URL(request.url).searchParams.get("from"))
    : `${access.base}/library/${b.libraryId}${b.path ? `?path=${encodeURIComponent(b.path)}` : ""}`;
  let data = { title: info.title, subtitle: info.subtitle, ownerKind: info.ownerKind, ownerId: info.ownerId, back, next: info.next ? `${access.base}/watch/episode/${info.next.id}` : null };
  // Playing through a playlist: what follows is the next thing in it (not the next episode of a season), and Back returns to the playlist.
  const queue = parseQueueContext(new URL(request.url).searchParams);
  if (queue) {
    const q = await tvQueueNext(db, access.scope, queue, params.kind === "title" ? { titleId: id } : { episodeId: id });
    if (q.valid) data = { ...data, back: `${access.base}/playlist/${queue.playlistId}`, next: q.next ? targetHref(access.base, q.next, queue.playlistId) : null };
  }
  // ?json=1: the player of a newer browser asks for the next episode's details so it can carry on without loading a page.
  if (new URL(request.url).searchParams.get("json") === "1") return json({ ...watchConfig(data), title: data.title, subtitle: data.subtitle, upNextSeconds: UP_NEXT_SECONDS });
  return html(watchPage(data));
}

/** Back from a clip in a photo library: to the favourites or album it was opened from, else to the timeline grid at that clip. */
function photoGridBack(base: string, b: { libraryId: string; after: string | null; folderPath: string }, from: string | null): string {
  const library = `${base}/library/${b.libraryId}`;
  if (from === "favorites") return `${library}?view=favorites`;
  if (from === "album") return `${library}?view=albums${b.folderPath ? `&path=${encodeURIComponent(b.folderPath)}` : ""}`;
  return `${library}${b.after ? `?after=${encodeURIComponent(b.after)}` : ""}`;
}
