import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { setTitleLabel } from "@/lib/labels/service";
import { LABEL_TITLE_KINDS } from "@/lib/labels/kinds";
import { visibleLabels } from "@/lib/labels/queries";
import { listPage, messagePage } from "@/tv/render";

/** The profile's own labels on this server, each opening the titles under it. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/labels">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const labels = await visibleLabels(db, { actor: access.scope.actor, viewer: access.scope.viewer, viewerId: access.scope.viewerId, serverId });
  return html(
    listPage({
      base: access.base,
      title: "Your labels",
      subtitle: labels.length ? "Only you see these. Make and change labels on the web or in the app." : "No labels yet. Make some on the web or in the app, then they show here.",
      backHref: access.base,
      actions: labels.map((l) => ({ href: `${access.base}/labels/${l.id}`, name: l.name, note: l.count === 1 ? "1 title" : `${l.count} titles` })),
      items: [],
      prevHref: null,
      nextHref: null,
    })
  );
}

/** Only a POST changes anything: puts a movie, show or book under one of the profile's labels (on=1) or takes it off (on=0), then returns. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/labels">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const label = asUuid(field("label") ?? "");
  const title = asUuid(field("title") ?? "");
  const on = field("on");
  if (!label || !title || (on !== "0" && on !== "1")) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const auth = await authorizeOwner("title", title, { titleKinds: [...LABEL_TITLE_KINDS] });
  if (!auth.ok || auth.member.viewer.id !== access.scope.viewerId || auth.serverId !== serverId || !(await setTitleLabel(db, access.scope.viewerId, label, title, on === "1"))) {
    return html(messagePage("Couldn't do that", "That label can't be changed.", { href: back, label: "Back" }), 404);
  }
  return redirectTo(request, back, 303);
}
