import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { libraryTitles } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { listPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/library/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const page = Math.min(Math.max(1, Math.floor(Number(new URL(request.url).searchParams.get("page"))) || 1), 10_000);
  const result = await libraryTitles(db, access.scope, id, page);
  if (!result) return notFoundPage();
  const here = `${access.base}/library/${id}`;
  return html(
    listPage({
      base: access.base,
      title: result.library.name,
      backHref: access.base,
      items: result.items.map((t) => ({ href: `${access.base}/${t.kind === "movie" ? "title" : "show"}/${t.id}`, name: t.name, meta: t.year ? String(t.year) : null, posterUrl: t.posterUrl })),
      prevHref: page > 1 ? `${here}?page=${page - 1}` : null,
      nextHref: result.hasMore ? `${here}?page=${page + 1}` : null,
    })
  );
}
