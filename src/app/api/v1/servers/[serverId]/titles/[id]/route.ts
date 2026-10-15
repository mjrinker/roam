import { db } from "@/lib/db/client";
import { collectionsOfTitle } from "@/lib/collections/queries";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { bookDetail, movieDetail, showDetail, visibleTitleKind } from "@/lib/tv/data";
import { loadMovieExtras } from "@/lib/title-extras";
import { ownershipView } from "@/lib/ownership/view";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess, type ApiAccess } from "@/lib/api/access";
import { playPath } from "@/lib/api/v1-shapes";

/** Who owns it, from this profile's side (null when the server doesn't track ownership). Claiming and withdrawing are at /api/ownership/*. */
async function ownership(access: ApiAccess, titleId: string, libraryKind: string) {
  const view = await ownershipView(db, { serverId: access.serverId, titleId, libraryKind, accountId: access.who.accountId, viewerId: access.scope.viewerId, isAdmin: false });
  if (!view) return null;
  return {
    claimMode: view.settings.claimMode,
    canChange: !access.who.limited,
    units: view.units.map((u) => ({ seasonId: u.seasonId, label: u.label, owners: u.owners.map((o) => ({ name: o.name, shared: o.shared, mine: o.mine })), iOwn: u.iOwn, myShared: u.myShared, claim: u.myClaim, playable: u.playable })),
  };
}

/**
 * A movie, a show (with one season's episodes: `?season=N`, the first by default) or an audiobook, with where the profile left off.
 * Movies come with their parental guide, chapters, extras and cast. To play: ask `play.manifestPath` for the manifest (see docs/api.md).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/titles/[id]">) {
  const params = await ctx.params;
  const a = await apiAccess(params.serverId);
  if (!a.ok) return a.response;
  const id = asId(params.id);
  if (!id) return apiNotFound();
  const { scope, serverId, who } = a.access;
  const found = await visibleTitleKind(db, scope, id);
  if (!found) return apiNotFound();
  const country = countryFromLocale(scope.viewer.locale);

  if (found.kind === "show") {
    const requested = Number(new URL(request.url).searchParams.get("season"));
    const show = await showDetail(db, scope, id, Number.isInteger(requested) ? requested : undefined);
    if (!show) return apiNotFound();
    const t = show.title;
    const next = show.episodes.find((e) => e.inProgress) ?? show.episodes.find((e) => !e.watched) ?? show.episodes[0] ?? null;
    return apiJson({
      type: "show",
      id,
      name: t.name,
      year: t.year,
      overview: t.overview,
      posterUrl: t.posterUrl,
      backdropUrl: t.backdropUrl,
      genres: t.genres ?? [],
      certification: displayCertification(t.certifications, country),
      libraryId: show.libraryId,
      watched: show.showWatched,
      seasons: show.seasons,
      season: show.currentSeason,
      episodes: show.episodes.map((e) => ({ type: "episode", id: e.id, number: e.number, name: e.name, watched: e.watched, inProgress: e.inProgress, playPath: playPath("episode", e.id) })),
      continueEpisodeId: next?.id ?? null,
      ownership: show.currentSeasonId ? await ownership(a.access, id, "shows") : null,
    });
  }

  if (found.kind === "audiobook") {
    const book = await bookDetail(db, scope, id);
    if (!book) return apiNotFound();
    const t = book.title;
    return apiJson({
      type: "audiobook",
      id,
      name: t.name,
      authors: t.authors?.length ? t.authors : t.folderAuthor ? [t.folderAuthor] : [],
      narrators: t.narrators ?? [],
      series: t.seriesName ? { name: t.seriesName, position: t.seriesPosition } : null,
      overview: t.overview,
      posterUrl: t.posterUrl,
      libraryId: book.libraryId,
      finished: book.finished,
      resume: book.resume,
      play: { manifestPath: playPath("audiobook", id) },
      ownership: await ownership(a.access, id, "audiobooks"),
    });
  }

  const movie = await movieDetail(db, scope, id);
  if (!movie) return apiNotFound();
  const t = movie.title;
  const extras = await loadMovieExtras(db, { serverId, titleId: id, title: { imdbId: t.imdbId, tmdbId: t.tmdbId }, filterPrefs: who.filterPrefs });
  return apiJson({
    type: "movie",
    id,
    name: t.name,
    year: t.year,
    overview: t.overview,
    posterUrl: t.posterUrl,
    backdropUrl: t.backdropUrl,
    runtimeSeconds: t.runtimeSeconds,
    genres: t.genres ?? [],
    certification: displayCertification(t.certifications, country),
    imdbRating: t.imdbRating,
    rottenTomatoesScore: t.rottenTomatoesScore,
    libraryId: movie.libraryId,
    finished: movie.finished,
    resume: movie.resume,
    play: { manifestPath: playPath("movie", id) },
    guide: extras.guide,
    chapters: extras.chapters,
    extras: extras.extras.map((g) => ({ category: g.category, items: g.items.map((i) => ({ ...i, playPath: `/api/play/extra/${i.id}` })) })),
    cast: extras.cast,
    ownership: await ownership(a.access, id, movie.libraryKind),
    collections: await collectionsOfTitle(db, { actor: scope.actor, viewer: scope.viewer, titleId: id }),
  });
}
