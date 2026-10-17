import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { changeStatus, removeWish, setWant } from "@/lib/wishlist/service";
import { messagePage } from "@/tv/render";

const ACTIONS = ["want", "unwant", "claim", "unclaim", "got", "reopen", "remove"] as const;

/** Only a POST changes the wishlist. A child's profile can look but not change it. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/wishlist/act">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const id = asUuid(field("id") ?? "");
  const action = ACTIONS.find((a) => a === field("action"));
  if (!id || !action) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const fail = (text: string) => html(messagePage("Couldn't do that", text, { href: back, label: "Back" }), 404);
  if (access.who.limited) return fail("This profile can look at the wishlist but not change it.");
  const accountId = access.who.accountId;
  const isAdmin = access.who.isAdmin;
  if (action === "want" || action === "unwant") {
    const r = await setWant(db, serverId, accountId, id, action === "want");
    if (!r.ok) return fail(r.error);
    return redirectTo(request, r.value.wants === 0 ? `${access.base}/wishlist` : back, 303); // a wish nobody wants any more is gone
  }
  if (action === "remove") {
    const r = await removeWish(db, serverId, accountId, isAdmin, id);
    if (!r.ok) return fail(r.error);
    return redirectTo(request, `${access.base}/wishlist`, 303);
  }
  const r = await changeStatus(db, serverId, accountId, isAdmin, id, action);
  if (!r.ok) return fail(r.error);
  return redirectTo(request, back, 303);
}
