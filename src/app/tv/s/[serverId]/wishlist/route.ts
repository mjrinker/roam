import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { isDone } from "@/lib/wishlist/filter";
import { WISH_KIND_LABEL } from "@/lib/wishlist/rules";
import { listWishes } from "@/lib/wishlist/service";
import { listPage } from "@/tv/render";

/** The server's shared wishlist: what is still wanted, most wanted first. Each opens a page with the buttons (adding is done on the web or in the app). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/wishlist">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const wishes = await listWishes(db, { serverId, actor: access.scope.actor, viewer: access.scope.viewer, accountId: access.who.accountId, isAdmin: access.who.isAdmin && !access.who.limited });
  const open = wishes.filter((w) => !isDone(w));
  return html(
    listPage({
      base: access.base,
      title: "Wishlist",
      subtitle: open.length ? "What this server would like to get next. Add to it on the web or in the app." : "Nothing on the wishlist yet. Add to it on the web or in the app.",
      backHref: access.base,
      items: open.map((w) => ({
        href: `${access.base}/wishlist/${w.id}`,
        name: w.title,
        meta: [WISH_KIND_LABEL[w.kind], w.year, w.status === "claimed" ? "Someone is getting it" : null, w.wants > 1 ? `${w.wants} want it` : null].filter(Boolean).join(" · "),
        posterUrl: w.posterUrl,
      })),
      prevHref: null,
      nextHref: null,
    })
  );
}
