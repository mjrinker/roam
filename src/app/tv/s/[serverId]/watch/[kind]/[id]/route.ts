import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { watchInfo } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { watchPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/watch/[kind]/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id || (params.kind !== "title" && params.kind !== "episode")) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const info = await watchInfo(db, access.scope, params.kind, id);
  if (!info) return notFoundPage();
  const back = info.back.kind === "title" ? `${access.base}/title/${info.back.id}` : `${access.base}/show/${info.back.id}?season=${info.back.season}`;
  return html(watchPage({ title: info.title, subtitle: info.subtitle, ownerKind: info.ownerKind, ownerId: info.ownerId, back, next: info.next ? `${access.base}/watch/episode/${info.next.id}` : null }));
}
