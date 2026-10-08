import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { watchInfo } from "@/lib/tv/data";
import { html, json } from "@/lib/tv/http";
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
    : b.kind === "photoGrid" ? `${access.base}/library/${b.libraryId}${b.after ? `?after=${encodeURIComponent(b.after)}` : ""}`
    : `${access.base}/library/${b.libraryId}${b.path ? `?path=${encodeURIComponent(b.path)}` : ""}`;
  const data = { title: info.title, subtitle: info.subtitle, ownerKind: info.ownerKind, ownerId: info.ownerId, back, next: info.next ? `${access.base}/watch/episode/${info.next.id}` : null };
  // ?json=1: the player of a newer browser asks for the next episode's details so it can carry on without loading a page.
  if (new URL(request.url).searchParams.get("json") === "1") return json({ ...watchConfig(data), title: data.title, subtitle: data.subtitle, upNextSeconds: UP_NEXT_SECONDS });
  return html(watchPage(data));
}
