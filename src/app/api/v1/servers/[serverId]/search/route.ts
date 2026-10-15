import { db } from "@/lib/db/client";
import { cleanQuery, tvSearch } from "@/lib/tv/search";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { refFromHref, type ApiItem } from "@/lib/api/v1-shapes";

/** Titles, books, audio files, albums and artists matching `?q=`, with the same rules as the web search (sharing and age limits). */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/search">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  const q = cleanQuery(new URL(request.url).searchParams.get("q"));
  const hits = await tvSearch(db, a.access.scope, q);
  const items: ApiItem[] = hits.flatMap((h) => {
    const ref = refFromHref(h.href);
    return ref ? [{ ...ref, name: h.name, subtitle: h.meta, posterUrl: h.posterUrl, square: h.square }] : [];
  });
  return apiJson({ query: q, items });
}
