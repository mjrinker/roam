import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { showDetail } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { detailPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/show/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const requested = Number(new URL(request.url).searchParams.get("season"));
  const show = await showDetail(db, access.scope, id, Number.isInteger(requested) ? requested : undefined);
  if (!show) return notFoundPage();
  const t = show.title;
  const here = `${access.base}/show/${id}`;
  return html(
    detailPage({
      title: t.name,
      meta: [t.year, show.seasons.length ? `${show.seasons.length} ${show.seasons.length === 1 ? "season" : "seasons"}` : null].filter(Boolean).join(" · "),
      overview: t.overview,
      posterUrl: t.posterUrl,
      backHref: `${access.base}/library/${show.libraryId}`,
      actions: show.episodes.length ? [{ href: `${access.base}/watch/episode/${(show.episodes.find((e) => e.inProgress) ?? show.episodes.find((e) => !e.watched) ?? show.episodes[0]).id}`, label: show.episodes.some((e) => e.inProgress) ? "Resume" : "Play", primary: true }] : [],
      seasons: show.seasons.length > 1 ? show.seasons.map((n) => ({ href: `${here}?season=${n}`, label: `Season ${n}`, current: n === show.currentSeason })) : [],
      episodes: show.episodes.map((e) => ({ href: `${access.base}/watch/episode/${e.id}`, label: `${e.number}. ${e.name ?? `Episode ${e.number}`}`, sub: e.watched ? "Watched" : e.inProgress ? "In progress" : null })),
    })
  );
}
