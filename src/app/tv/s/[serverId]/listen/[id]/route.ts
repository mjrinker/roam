import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { listenInfo } from "@/lib/tv/data";
import { listenPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/listen/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const info = await listenInfo(db, access.scope, id);
  if (!info) return notFoundPage();
  return html(
    listenPage({
      title: info.name,
      subtitle: info.subtitle,
      coverUrl: info.coverUrl,
      ownerId: info.id,
      remembers: info.remembers,
      skip: info.libraryKind === "audiobooks" ? 30 : 10,
      back: `${access.base}${info.back}`,
      next: info.next ? `${access.base}${info.next}` : null,
      queue: info.queue,
    })
  );
}
