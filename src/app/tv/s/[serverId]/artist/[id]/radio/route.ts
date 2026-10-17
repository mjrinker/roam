import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { radioQueue } from "@/lib/tv/data";
import { redirectTo } from "@/lib/tv/http";
import { newSeed } from "@/lib/tv/shuffle";

/**
 * Starts a radio from an artist: songs from this library that sound like it, one after another. The seed in the address fixes the order, so each
 * song's page knows what follows it (the same way a shuffle does).
 */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/artist/[id]/radio">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const seed = newSeed();
  const radio = await radioQueue(db, access.scope, id, seed);
  if (!radio || radio.songs.length === 0) return notFoundPage();
  return redirectTo(request, `${access.base}/listen/${radio.songs[0].id}?radio=${id}&rseed=${seed}`);
}
