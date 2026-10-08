import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { randomPhotoId } from "@/lib/tv/data";
import { redirectTo } from "@/lib/tv/http";

/** Starts a slideshow at a random picture; with no pictures to show it just returns to the home screen. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/screensaver">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const id = await randomPhotoId(db, access.scope);
  return redirectTo(request, id ? `${access.base}/photo/${id}?saver=1#slide` : access.base);
}
