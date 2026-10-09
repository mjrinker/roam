import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { artistSongs } from "@/lib/tv/data";
import { redirectTo } from "@/lib/tv/http";
import { newSeed, shuffled } from "@/lib/tv/shuffle";

/** Starts playing all of an artist's songs, in order or (with ?shuffle=1) shuffled, by sending the TV to the first song with the queue in the address. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/artist/[id]/play">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const all = await artistSongs(db, access.scope, id);
  if (!all || all.songs.length === 0) return notFoundPage();
  if (new URL(request.url).searchParams.get("shuffle") === "1") {
    const seed = newSeed();
    return redirectTo(request, `${access.base}/listen/${shuffled(all.songs, seed)[0].id}?artist=${id}&shuffle=${seed}`);
  }
  return redirectTo(request, `${access.base}/listen/${all.songs[0].id}?artist=${id}`);
}
