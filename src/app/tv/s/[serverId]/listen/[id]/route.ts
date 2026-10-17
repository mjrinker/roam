import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { listenInfo } from "@/lib/tv/data";
import { parseQueueContext, targetHref, tvQueueNext } from "@/lib/tv/queue";
import { parseSeed } from "@/lib/tv/shuffle";
import { listenPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/listen/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const query = new URL(request.url).searchParams;
  const artistId = asUuid(query.get("artist") ?? "");
  const seed = parseSeed(query.get("shuffle"));
  const radioArtist = asUuid(query.get("radio") ?? "");
  const radioSeed = parseSeed(query.get("rseed"));
  const radio = radioArtist && radioSeed ? { artistId: radioArtist, seed: radioSeed } : null;
  const info = await listenInfo(db, access.scope, id, { artistId, shuffleSeed: seed, radio });
  if (!info) return notFoundPage();
  // Playing through a playlist: its order replaces an album's, and Back returns to the playlist.
  let nextHref = info.next ? `${access.base}${info.next}${carried(info.back, artistId, seed, radio)}` : null;
  let backHref = `${access.base}${info.back}`;
  let queue = info.queue;
  const inPlaylist = parseQueueContext(query);
  if (inPlaylist) {
    const q = await tvQueueNext(db, access.scope, inPlaylist, { titleId: id });
    if (q.valid) {
      nextHref = q.next ? targetHref(access.base, q.next, inPlaylist.playlistId, inPlaylist.shuffle) : null;
      backHref = `${access.base}/playlist/${inPlaylist.playlistId}`;
      queue = null;
    }
  }
  return html(
    listenPage({
      title: info.name,
      subtitle: info.subtitle,
      coverUrl: info.coverUrl,
      ownerId: info.id,
      remembers: info.remembers,
      skip: info.libraryKind === "audiobooks" ? 30 : 10,
      back: backHref,
      // The way the queue was made (an artist's songs, a shuffle seed) rides along to the next song's page.
      next: nextHref,
      queue,
    })
  );
}

/** The address parts that keep an artist's play-all and a shuffle going from one song's page to the next. */
function carried(back: string, artistId: string | null, seed: number | null, radio: { artistId: string; seed: number } | null): string {
  const parts = [artistId && back === `/artist/${artistId}` && !radio ? `artist=${artistId}` : "", seed ? `shuffle=${seed}` : "", radio ? `radio=${radio.artistId}&rseed=${radio.seed}` : ""].filter(Boolean);
  return parts.length ? `?${parts.join("&")}` : "";
}
