import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { setOnWatchlist } from "@/lib/watchlist/service";
import { messagePage } from "@/tv/render";

/** Only a POST changes the watch list. Opening this address in a browser just goes to the server's TV home. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/watchlist">) {
  const serverId = asUuid((await ctx.params).serverId);
  return redirectTo(request, serverId ? `/tv/s/${serverId}` : "/tv");
}

/** Puts a movie, show or audiobook on the profile's watch list (on=1) or takes it off (on=0), then returns to the page it came from. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/watchlist">) {
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
  const on = field("on");
  if (!id || (on !== "0" && on !== "1")) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const result = await setOnWatchlist({ titleId: id, on: on === "1" });
  if (!result.ok) return html(messagePage("Couldn't do that", "That can't go on a watch list.", { href: back, label: "Back" }), 404);
  return redirectTo(request, back, 303);
}
