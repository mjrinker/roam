import { db } from "@/lib/db/client";
import { similarTitles } from "@/lib/recommend/service";
import { averageOf, ratingsOf } from "@/lib/ratings/service";
import { collectionsOfTitle, moreInCollections } from "@/lib/collections/queries";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { bookDetail, movieDetail, showDetail, visibleTitleKind } from "@/lib/tv/data";
import { loadMovieExtras } from "@/lib/title-extras";
import { ownershipView } from "@/lib/ownership/view";
import { apiJson, apiNotFound, asId } from "@/lib/api/v1";
import { apiAccess, type ApiAccess } from "@/lib/api/access";
import { playPath } from "@/lib/api/v1-shapes";
import { onWatchlist } from "@/lib/watchlist/queries";

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
  /** This profile's own rating in half stars (1 to 10), or null. */
  const myRating = (await ratingsOf(db, scope.viewerId, "title", [id])).get(id) ?? null;
  const inWatchlist = (await onWatchlist(db, scope.viewerId, [id])).has(id);
  /** What everyone on the server gave it, on average: `{ halfStars, count }`, or null when nobody has rated it. */
  const averageRating = (await averageOf(db, "title", [id])).get(id) ?? null;
  /** Titles like this one, as list items (films for a film, shows for a show). */
  const similarItems = async () => (await similarTitles(db, { actor: scope.actor, viewer: scope.viewer, titleId: id })).map((r) => ({ type: r.kind, id: r.id, name: r.name, subtitle: r.year ? String(r.year) : null, posterUrl: r.posterUrl, square: false }));

  if (found.kind === "show") {
    const requested = Number(new URL(request.url).searchParams.get("season"));
    const show = await showDetail(db, scope, id, Number.isInteger(requested) ? requested : undefined);
    const episodeRatings = show ? await ratingsOf(db, scope.viewerId, "episode", show.episodes.map((e) => e.id)) : new Map<string, number>();
    const episodeAverages = show ? await averageOf(db, "episode", show.episodes.map((e) => e.id)) : new Map<string, { halfStars: number; count: number }>();
    if (!show) return apiNotFound();
    const t = show.title;
    const next = show.episodes.find((e) => e.inProgress) ?? show.episodes.find((e) => !e.watched) ?? show.episodes[0] ?? null;
    return apiJson({
    myRating,
    inWatchlist,
    averageRating,
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
      episodes: show.episodes.map((e) => ({ type: "episode", id: e.id, number: e.number, name: e.name, watched: e.watched, inProgress: e.inProgress, playPath: playPath("episode", e.id), myRating: episodeRatings.get(e.id) ?? null, averageRating: episodeAverages.get(e.id) ?? null })),
      continueEpisodeId: next?.id ?? null,
      similar: await similarItems(),
      ownership: show.currentSeasonId ? await ownership(a.access, id, "shows") : null,
    });
  }

  if (found.kind === "audiobook") {
    const book = await bookDetail(db, scope, id);
    if (!book) return apiNotFound();
    const t = book.title;
    return apiJson({
    myRating,
    inWatchlist,
    averageRating,
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
    myRating,
    inWatchlist,
    averageRating,
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
    similar: await similarItems(),
    moreInCollections: (await moreInCollections(db, { actor: scope.actor, viewer: scope.viewer, titleId: id })).map((c) => ({
      id: c.id,
      name: c.name,
      items: c.items.map((i) => ({ type: i.kind, id: i.id, name: i.name, subtitle: i.year ? String(i.year) : null, posterUrl: i.posterUrl, square: i.kind === "audiobook" })),
    })),
  });
}
