import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { episodeDetail } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { ratingSection } from "@/lib/tv/sections";
import { averageOf, ratingsOf } from "@/lib/ratings/service";
import { detailPage } from "@/tv/render";

/** One episode: play it, rate it, mark it watched. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/episode/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const e = await episodeDetail(db, access.scope, id);
  if (!e) return notFoundPage();
  const here = `${access.base}/episode/${id}`;
  const mine = (await ratingsOf(db, access.scope.viewerId, "episode", [id])).get(id) ?? null;
  return html(
    detailPage({
      title: e.name ?? `Episode ${e.number}`,
      meta: `${e.showName} · Season ${e.season}, episode ${e.number}`,
      overview: e.overview,
      posterUrl: e.stillUrl ?? e.showPosterUrl,
      backdropUrl: e.showBackdropUrl,
      backHref: `${access.base}/show/${e.showId}?season=${e.season}`,
      actions: [{ href: `${access.base}/watch/episode/${id}`, label: "Play", primary: true }],
      posts: [{ action: `${access.base}/mark`, label: e.watched ? "Mark as not watched" : "Mark as watched", fields: { kind: "episode", id, done: e.watched ? "0" : "1", back: here } }],
      sections: [ratingSection({ base: access.base, kind: "episode", id, back: here, mine, average: (await averageOf(db, "episode", [id])).get(id) ?? null })],
    })
  );
}
