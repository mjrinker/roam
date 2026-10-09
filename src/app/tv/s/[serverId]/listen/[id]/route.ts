import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { listenInfo } from "@/lib/tv/data";
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
  const info = await listenInfo(db, access.scope, id, { artistId, shuffleSeed: seed });
  if (!info) return notFoundPage();
  return html(
    listenPage({
      title: info.name,
      subtitle: info.subtitle,
      coverUrl: info.coverUrl,
      ownerId: info.id,
      remembers: info.remembers,
      skip: info.libraryKind === "audiobooks" ? 30 : 10,
      back: `${access.base}${info.back}`,
      // The way the queue was made (an artist's songs, a shuffle seed) rides along to the next song's page.
      next: info.next ? `${access.base}${info.next}${carried(info.back, artistId, seed)}` : null,
      queue: info.queue,
    })
  );
}

/** The address parts that keep an artist's play-all and a shuffle going from one song's page to the next. */
function carried(back: string, artistId: string | null, seed: number | null): string {
  const parts = [artistId && back === `/artist/${artistId}` ? `artist=${artistId}` : "", seed ? `shuffle=${seed}` : ""].filter(Boolean);
  return parts.length ? `?${parts.join("&")}` : "";
}
