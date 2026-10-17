import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { WISH_KIND_LABEL } from "@/lib/wishlist/rules";
import { listWishes } from "@/lib/wishlist/service";
import { detailPage } from "@/tv/render";

/** One wish: who wants it, and the buttons a profile may press (I want this too, I'll get this, we got it, remove). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/wishlist/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const isAdmin = access.who.isAdmin && !access.who.limited;
  const wish = (await listWishes(db, { serverId, actor: access.scope.actor, viewer: access.scope.viewer, accountId: access.who.accountId, isAdmin })).find((w) => w.id === id);
  if (!wish) return notFoundPage();
  const here = `${access.base}/wishlist/${id}`;
  const act = (action: string, label: string) => ({ action: `${access.base}/wishlist/act`, label, fields: { id, action, back: here } });
  const done = wish.status === "got" || !!wish.onServer;
  const posts = access.who.limited
    ? []
    : [
        ...(done ? [] : [wish.iWant ? act("unwant", "You want this: stop wanting it") : act("want", "I want this too")]),
        ...(wish.status === "wanted" && !wish.onServer ? [act("claim", "I'll get this")] : []),
        ...(wish.status === "claimed" ? [act("got", "We got it"), ...(wish.claimedByMe || isAdmin ? [act("unclaim", "Not me after all")] : [])] : []),
        ...(wish.status === "got" && isAdmin ? [act("reopen", "Put it back on the list")] : []),
        ...(wish.canRemove ? [act("remove", "Take it off the wishlist")] : []),
      ];
  return html(
    detailPage({
      title: wish.title,
      meta: [WISH_KIND_LABEL[wish.kind], wish.year, wish.creator, wish.wants === 1 ? "1 household wants this" : `${wish.wants} households want this`, wish.status === "claimed" ? (wish.claimedByMe ? "You're getting this" : `${wish.claimedByName} is getting this`) : null, wish.status === "got" ? "Got it" : null].filter(Boolean).join(" · "),
      overview: [wish.overview, wish.note ? `Note: ${wish.note}` : null, wish.wantedBy.length ? `Wanted by ${wish.wantedBy.join(", ")}` : null].filter(Boolean).join("\n\n") || null,
      posterUrl: wish.posterUrl,
      backHref: `${access.base}/wishlist`,
      actions: wish.onServer ? [{ href: `${access.base}/${wish.kind === "show" ? "show" : "title"}/${wish.onServer.titleId}`, label: "Now on the server: open it", primary: true }] : [],
      posts,
    })
  );
}
