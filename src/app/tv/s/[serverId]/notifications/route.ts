import { db } from "@/lib/db/client";
import { listNotifications, markRead } from "@/lib/ownership/notify";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { visibleTitleKind } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { linesPage } from "@/tv/render";

/** What the bell shows on the web: claims, answers to claims, and "free now". Looking at the page marks them read. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/notifications">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const items = (await listNotifications(db, access.who.accountId)).filter((n) => !n.serverId || n.serverId === serverId);
  const lines = [];
  for (const n of items) {
    // A title this profile may open goes to its page (a show, book or movie each have their own); the admin's review is on the web.
    let href: string | null = null;
    if (n.titleId && n.kind !== "claim_waiting") {
      const found = await visibleTitleKind(db, access.scope, n.titleId);
      if (found) href = `${access.base}/${found.kind === "show" ? "show" : found.kind === "audiobook" ? "book" : "title"}/${n.titleId}`;
    }
    lines.push({ text: n.message, sub: `${n.createdAt.toLocaleDateString("en-US")}${n.readAt ? "" : " · new"}`, href });
  }
  await markRead(db, access.who.accountId);
  return html(linesPage({ title: "Notifications", backHref: access.base, lines, empty: "Nothing new." }));
}
