import { z } from "zod";
import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { visibleTitleKind } from "@/lib/tv/data";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { removeOwner, setShared, submitClaim } from "@/lib/ownership/owners";
import { announceFreed } from "@/lib/ownership/sessions";
import { seasons } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { messagePage } from "@/tv/render";

const actions = z.enum(["claim", "withdraw", "share", "giveup"]);

/** Only a POST changes anything. Opening this address in a browser just goes to the server's TV home. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/ownership">) {
  const serverId = asUuid((await ctx.params).serverId);
  return redirectTo(request, serverId ? `/tv/s/${serverId}` : "/tv");
}

/** A household says it owns a title (or a season of a show), withdraws its copy, shares it again, or gives up the claim. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/ownership">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  // Ownership belongs to the household: a child's profile can look but not change it.
  if (access.who.limited) return html(messagePage("Ask a grown-up", "This can be changed from a grown-up's profile.", { href: access.base, label: "Back" }), 403);
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const action = actions.safeParse(field("action"));
  const titleId = asUuid(field("titleId") ?? "");
  const rawSeason = field("seasonId");
  const seasonId = rawSeason ? asUuid(rawSeason) : null;
  if (!action.success || !titleId || (rawSeason && !seasonId)) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const found = await visibleTitleKind(db, access.scope, titleId);
  if (!found) return notFoundPage();
  // A show is owned a season at a time, and the season has to be that show's.
  if (found.kind === "show" ? !seasonId : seasonId) return notFoundPage();
  if (seasonId) {
    const [s] = await db.select({ titleId: seasons.titleId }).from(seasons).where(eq(seasons.id, seasonId)).limit(1);
    if (!s || s.titleId !== titleId) return notFoundPage();
  }
  const unit = { titleId, seasonId };
  if (action.data === "claim") {
    const r = await submitClaim(db, { titleId, seasonId, accountId: access.who.accountId });
    if (r.status === "disabled" || r.status === "not_found") return notFoundPage();
  } else if (action.data === "giveup") {
    await removeOwner(db, unit, access.who.accountId);
  } else {
    const ok = await setShared(db, unit, access.who.accountId, action.data === "share");
    if (ok && action.data === "share") await announceFreed(db, unit);
  }
  return redirectTo(request, back, 303); // 303: the browser must GET the page, never re-send the form
}
