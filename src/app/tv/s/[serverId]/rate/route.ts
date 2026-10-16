import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { setRating } from "@/lib/ratings/service";
import { messagePage } from "@/tv/render";

/** Only a POST rates anything. Opening this address in a browser just goes to the server's TV home. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/rate">) {
  const serverId = asUuid((await ctx.params).serverId);
  return redirectTo(request, serverId ? `/tv/s/${serverId}` : "/tv");
}

/** Rates a title, episode or album in whole stars (stars=1 to 5; 0 clears it), then returns to the page it came from. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/rate">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const kind = field("kind");
  const id = asUuid(field("id") ?? "");
  const stars = Number(field("stars"));
  if ((kind !== "title" && kind !== "episode" && kind !== "album") || !id || !Number.isInteger(stars) || stars < 0 || stars > 5) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const result = await setRating({ kind, id, halfStars: stars === 0 ? null : stars * 2 });
  if (!result.ok) return html(messagePage("Couldn't save that", "That can't be rated.", { href: back, label: "Back" }), 404);
  return redirectTo(request, back, 303);
}
