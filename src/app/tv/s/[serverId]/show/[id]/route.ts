import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { showDetail } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { ownershipSections, ratingSection } from "@/lib/tv/sections";
import { ratingsOf } from "@/lib/ratings/service";
import { detailPage } from "@/tv/render";
import { starsText } from "@/lib/ratings/stars";

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
  const mine = (await ratingsOf(db, access.scope.viewerId, "title", [id])).get(id) ?? null;
  const episodeMine = await ratingsOf(db, access.scope.viewerId, "episode", show.episodes.map((e) => e.id));
  const rateEpisodes = show.episodes.length
    ? [{ heading: "Rate or mark an episode", lines: show.episodes.map((e) => ({ text: `${e.number}. ${e.name ?? `Episode ${e.number}`}`, sub: episodeMine.has(e.id) ? `Your rating: ${starsText(episodeMine.get(e.id) as number)}` : "Not rated", href: `${access.base}/episode/${e.id}` })) }]
    : [];
  const sections = [ratingSection({ base: access.base, kind: "title", id, back: `${here}${show.currentSeason ? `?season=${show.currentSeason}` : ""}`, mine }), ...rateEpisodes, ...(await ownershipSections(db, { serverId, base: access.base, who: access.who, viewerId: access.scope.viewerId, libraryKind: "shows", titleId: id, seasonId: show.currentSeasonId, back: `${here}${show.currentSeason ? `?season=${show.currentSeason}` : ""}` }))];
  return html(
    detailPage({
      sections,
      title: t.name,
      meta: [t.year, show.seasons.length ? `${show.seasons.length} ${show.seasons.length === 1 ? "season" : "seasons"}` : null].filter(Boolean).join(" · "),
      overview: t.overview,
      posterUrl: t.posterUrl,
      backdropUrl: t.backdropUrl,
      posts: show.episodes.length === 0 ? [] : [
        { action: `${access.base}/mark`, label: show.showWatched ? "Mark show as unwatched" : "Mark show as watched", fields: { kind: "show", id, done: show.showWatched ? "0" : "1", back: here } },
        ...(show.currentSeasonId && show.seasons.length > 1
          ? [{ action: `${access.base}/mark`, label: show.episodes.every((e) => e.watched) ? `Mark season ${show.currentSeason} as unwatched` : `Mark season ${show.currentSeason} as watched`, fields: { kind: "season", id: show.currentSeasonId, done: show.episodes.every((e) => e.watched) ? "0" : "1", back: `${here}?season=${show.currentSeason}` } }]
          : []),
      ],
      backHref: `${access.base}/library/${show.libraryId}`,
      actions: [...(show.episodes.length ? [{ href: `${access.base}/watch/episode/${(show.episodes.find((e) => e.inProgress) ?? show.episodes.find((e) => !e.watched) ?? show.episodes[0]).id}`, label: show.episodes.some((e) => e.inProgress) ? "Resume" : "Play", primary: true }] : []), { href: `${access.base}/add?title=${id}&back=${encodeURIComponent(`${access.base}/show/${id}`)}`, label: "Add to playlist" }],
      seasons: show.seasons.length > 1 ? show.seasons.map((n) => ({ href: `${here}?season=${n}`, label: `Season ${n}`, current: n === show.currentSeason })) : [],
      episodes: show.episodes.map((e) => ({ href: `${access.base}/watch/episode/${e.id}`, label: `${e.number}. ${e.name ?? `Episode ${e.number}`}`, sub: e.watched ? "Watched" : e.inProgress ? "In progress" : null })),
    })
  );
}
