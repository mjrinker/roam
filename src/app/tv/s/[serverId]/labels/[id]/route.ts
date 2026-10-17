import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { labelWithTitles } from "@/lib/labels/queries";
import { listPage } from "@/tv/render";

/** The titles under one of the profile's labels that it can see (ebooks aren't on a TV). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/labels/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const label = await labelWithTitles(db, { actor: access.scope.actor, viewer: access.scope.viewer, viewerId: access.scope.viewerId, serverId }, id);
  if (!label) return notFoundPage();
  const hrefOf = (kind: string, tid: string) => `${access.base}/${kind === "show" ? "show" : kind === "audiobook" ? "book" : "title"}/${tid}`;
  return html(
    listPage({
      base: access.base,
      title: label.name,
      subtitle: "Your label",
      backHref: `${access.base}/labels`,
      items: label.titles.filter((t) => t.kind !== "ebook").map((t) => ({ href: hrefOf(t.kind, t.id), name: t.name, meta: t.year ? String(t.year) : null, posterUrl: t.posterUrl, square: t.kind === "audiobook" })),
      prevHref: null,
      nextHref: null,
    })
  );
}
