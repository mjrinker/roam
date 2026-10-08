import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { cleanQuery, SEARCH_MAX, tvSearch } from "@/lib/tv/search";
import { searchPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/search">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const params = new URL(request.url).searchParams;
  // Keep a trailing space (the person is mid-phrase) but never more than the limit; the search itself ignores it.
  const typed = (params.get("q") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").replace(/^ /, "").slice(0, SEARCH_MAX);
  const key = params.get("k");
  const results = await tvSearch(db, access.scope, cleanQuery(typed));
  return html(
    searchPage({
      base: access.base,
      query: typed,
      focusKey: key && /^([a-z0-9]|space|del|clear)$/.test(key) ? key : null,
      max: SEARCH_MAX,
      results: results.map((r) => ({ href: `${access.base}${r.href}`, name: r.name, meta: r.meta, posterUrl: r.posterUrl, square: r.square })),
    })
  );
}
