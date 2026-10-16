import { refreshIfStale } from "@/lib/tmdb/cache";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Play } from "lucide-react";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles, watchState } from "@/lib/db/schema";
import { defaultVersionRows } from "@/lib/player/versions";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { isAllowed } from "@/lib/content/access";
import { formatRuntime } from "@/lib/format";
import { ratingsOf } from "@/lib/ratings/service";
import { StarRating } from "@/components/ratings/star-rating";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { TitleResyncButton } from "@/components/admin/title-resync-button";
import { TmdbMatchButton } from "@/components/admin/tmdb-match-button";
import { FixAudioButton } from "@/components/admin/fix-audio-button";
import { needsAudioFix } from "@/lib/scan/codec-support";
import { DetailHero } from "@/components/library/detail-hero";
import { MarkDoneButton } from "@/components/library/mark-done-button";
import { MoreMenu } from "@/components/shell/more-menu";
import { AddToPlaylistMenu } from "@/components/playlists/add-to-playlist-menu";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { loadTitleCast, loadTitleCrew } from "@/lib/cast/queries";
import { CastRow } from "@/components/library/cast-row";
import { OwnershipSection } from "@/components/ownership/ownership-section";
import { CrewRow } from "@/components/library/crew-row";
import { SeasonEpisodes, type EpisodeRowData } from "@/components/library/season-episodes";
import { chaptersFromRows } from "@/lib/chapters/rows";
import { PlayChoicesButton } from "@/components/library/play-choices";
import { cuesFromRows } from "@/lib/content-filter/rows";
import { guideFromCues } from "@/lib/content-filter/playback";
import { episodeLines, loadDddForShow } from "@/lib/ddd/page";
import { mergeGuideLines } from "@/lib/ddd/transform";
import { normalizePrefs } from "@/lib/content-filter/categories";

export default async function ShowDetailPage({
  params,
}: PageProps<"/s/[serverId]/show/[id]">) {
  const { serverId, id } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);

  // Its TMDB details are about five months old: refresh them before drawing the page, so what is shown is current (a short wait, once).
  const [known] = await db.select({ tmdbId: titles.tmdbId, kind: titles.kind }).from(titles).where(eq(titles.id, id)).limit(1);
  if (known?.tmdbId && known.kind === "show") await refreshIfStale("tv", known.tmdbId);

  const [row] = await db
    .select({ show: titles, libraryId: libraries.id, libraryName: libraries.name })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), libraryVisible(db, lib)))
    .limit(1);
  const show = row?.show;
  if (!show || !isAllowed(viewer, show.ratingAges)) notFound();
  // Symmetric with the movie page redirecting the other way.
  if (show.kind === "movie") redirect(`/s/${serverId}/title/${id}`);
  if (show.kind !== "show") notFound();

  const allSeasons = await db
    .select()
    .from(seasons)
    .where(eq(seasons.titleId, id))
    .orderBy(asc(seasons.number));

  const seasonIds = allSeasons.map((s) => s.id);
  const allEpisodes = seasonIds.length
    ? await db
        .select()
        .from(episodes)
        .where(inArray(episodes.seasonId, seasonIds))
        .orderBy(asc(episodes.number))
    : [];

  const episodeIds = allEpisodes.map((e) => e.id);
  const [segments, states] = await Promise.all([
    episodeIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(and(eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, episodeIds)))
      : Promise.resolve([]),
    episodeIds.length
      ? db
          .select()
          .from(watchState)
          .where(
            and(
              eq(watchState.viewerId, viewer.id),
              eq(watchState.ownerKind, "episode"),
              inArray(watchState.ownerId, episodeIds)
            )
          )
      : Promise.resolve([]),
  ]);

  const seasonNumberById = new Map(allSeasons.map((s) => [s.id, s.number]));
  const stateByEpisode = new Map(states.map((s) => [s.ownerId, s]));
  const filesByEpisode = new Map<string, typeof segments>();
  // An episode saved in several resolutions is still one episode: only its default version's files count.
  const defaultSegments = [...groupBy(segments)].flatMap(([, rows]) => defaultVersionRows(rows));
  for (const f of defaultSegments) {
    // Guaranteed non-null by the ownerKind="episode" filter above — a
    // variant row (ownerKind null) never matches that query. The guard
    // just satisfies ownerId's now-nullable type (see schema.ts).
    if (!f.ownerId) continue;
    const list = filesByEpisode.get(f.ownerId) ?? [];
    list.push(f);
    filesByEpisode.set(f.ownerId, list);
  }

  // Watch order: season, then episode number.
  const ordered = [...allEpisodes].sort(
    (a, b) =>
      (seasonNumberById.get(a.seasonId) ?? 0) - (seasonNumberById.get(b.seasonId) ?? 0) ||
      a.number - b.number
  );

  // The community's scenes for the whole show (one set covers every episode; asked once, then kept; see lib/ddd).
  const ddd = await loadDddForShow(db, serverId, show);
  const episodeRatings = await ratingsOf(db, viewer.id, "episode", ordered.map((e) => e.id));
  const rows: EpisodeRowData[] = ordered.map((ep) => {
    const files = filesByEpisode.get(ep.id) ?? [];
    const state = stateByEpisode.get(ep.id);
    const inProgress = !!state && !state.finished && state.positionSeconds > 0;
    return {
      id: ep.id,
      seasonId: ep.seasonId,
      number: ep.number,
      name: ep.name,
      overview: ep.overview,
      stillUrl: ep.stillUrl,
      runtimeLabel: formatRuntime(ep.runtimeSeconds),
      ready: files.length > 0 && files.every((f) => f.durationSeconds != null),
      progressFraction:
        inProgress && state.durationSeconds ? state.positionSeconds / state.durationSeconds : 0,
      watched: state?.finished ?? false,
      myRating: episodeRatings.get(ep.id) ?? null,
      chapters: chaptersFromRows(files),
      guide: mergeGuideLines(guideFromCues(cuesFromRows(files)), episodeLines(ddd, seasonNumberById.get(ep.seasonId) ?? -1, ep.number)),
      dddUrl: ddd.pending ? `/api/ddd/episode/${ep.id}` : undefined,
    };
  });

  // "Up next": the episode you were partway through (most recent), else the
  // one after your last finished episode, else the very first.
  const inProgressState = [...states]
    .filter((s) => !s.finished && s.positionSeconds > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  let nextRow: EpisodeRowData | undefined;
  let resuming = false;
  if (inProgressState) {
    nextRow = rows.find((r) => r.id === inProgressState.ownerId);
    resuming = !!nextRow;
  }
  if (!nextRow) {
    const lastFinishedIdx = rows.reduce((acc, r, i) => (r.watched ? i : acc), -1);
    nextRow = rows[lastFinishedIdx + 1] ?? rows[0];
  }
  const nextSeasonNumber = nextRow ? seasonNumberById.get(nextRow.seasonId) : undefined;
  const nextLabel = nextRow
    ? `${resuming ? "Resume" : "Play"} S${nextSeasonNumber} · E${nextRow.number}`
    : null;

  const filterPrefs = normalizePrefs(viewer.contentFilter);
  const totalEpisodes = allEpisodes.length;
  const mine = (await ratingsOf(db, viewer.id, "title", [show.id])).get(show.id) ?? null;
  const cast = await loadTitleCast(db, show.id);
  const crew = await loadTitleCrew(db, show.id);

  return (
    <div className="flex flex-col gap-8">
      <DetailHero
        kind="show"
        title={show.name}
        myRating={<StarRating kind="title" id={show.id} initial={mine} />}
        backdropUrl={show.backdropUrl}
        posterUrl={show.posterUrl}
        externalRatings={{ imdbRating: show.imdbRating, rottenTomatoesScore: show.rottenTomatoesScore }}
        genres={show.genres}
        overview={show.overview}
        breadcrumbs={
          <Breadcrumbs
            serverId={serverId}
            trail={[
              { label: row.libraryName, href: `/s/${serverId}/library/${row.libraryId}` },
              { label: show.name },
            ]}
          />
        }
        meta={[
          show.year ? String(show.year) : null,
          displayCertification(show.certifications, countryFromLocale(viewer.locale)),
          `${allSeasons.length} season${allSeasons.length === 1 ? "" : "s"}`,
          totalEpisodes > 0 && `${totalEpisodes} episode${totalEpisodes === 1 ? "" : "s"}`,
        ]}
      >
        {nextRow?.ready && nextLabel && (
          <PlayChoicesButton
            href={`/s/${serverId}/watch/episode/${nextRow.id}`}
            lines={nextRow.guide}
            prefs={filterPrefs}
            dddUrl={nextRow.dddUrl}
            className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
          >
            <Play className="size-5" fill="currentColor" />
            {nextLabel}
          </PlayChoicesButton>
        )}
        <AddToPlaylistMenu serverId={serverId} target={{ titleId: show.id }} />
        <MoreMenu>
          {rows.length > 0 && <MarkDoneButton kind="show" id={show.id} done={rows.some((r) => r.ready) && rows.filter((r) => r.ready).every((r) => r.watched)} media="watch" scope="show" />}
          {role === "admin" && <TitleResyncButton titleId={show.id} titleName={show.name} />}
          {role === "admin" && <TmdbMatchButton titleId={show.id} titleName={show.name} kind="show" />}
          {role === "admin" && needsAudioFix(segments) && <FixAudioButton titleId={show.id} titleName={show.name} />}
        </MoreMenu>
      </DetailHero>

      <SeasonEpisodes
        serverId={serverId}
        seasons={allSeasons.map((s) => ({ id: s.id, number: s.number }))}
        episodes={rows}
        initialSeasonId={nextRow?.seasonId ?? allSeasons[0]?.id ?? ""}
        prefs={filterPrefs}
      />
      <div className="flex flex-col gap-8 px-4 pb-16 sm:px-8">
        <OwnershipSection serverId={serverId} titleId={show.id} libraryKind="shows" accountId={profile.id} viewerId={viewer.id} isAdmin={role === "admin"} limited={viewer.role === "limited"} />
        <CastRow serverId={serverId} cast={cast} />
        <CrewRow serverId={serverId} crew={crew} />
      </div>
    </div>
  );
}

function groupBy<T extends { ownerId: string | null }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.ownerId) continue;
    groups.set(r.ownerId, [...(groups.get(r.ownerId) ?? []), r]);
  }
  return groups;
}
