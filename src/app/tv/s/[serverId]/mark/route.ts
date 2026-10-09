import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { markDone } from "@/lib/watch/service";
import { messagePage } from "@/tv/render";

/** Only a POST marks anything. Opening this address in a browser just goes to the server's TV home. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/mark">) {
  const serverId = asUuid((await ctx.params).serverId);
  return redirectTo(request, serverId ? `/tv/s/${serverId}` : "/tv");
}

/** Marks a title, episode, season or show as watched / listened to / read (done=1) or not (done=0), then returns to the page it came from. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/mark">) {
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
  const done = field("done");
  if ((kind !== "title" && kind !== "episode" && kind !== "season" && kind !== "show") || !id || (done !== "0" && done !== "1")) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  const result = await markDone({ kind, id, done: done === "1" });
  if (!result.ok) return html(messagePage("Couldn't change that", "That can't be marked.", { href: back, label: "Back" }), 404);
  return redirectTo(request, back);
}
