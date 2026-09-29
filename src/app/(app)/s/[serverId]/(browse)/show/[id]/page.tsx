import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Play } from "lucide-react";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { isAllowed } from "@/lib/content/access";
import { formatRuntime } from "@/lib/format";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { Button } from "@/components/ui/button";
import { TitleResyncButton } from "@/components/admin/title-resync-button";
import { FixAudioButton } from "@/components/admin/fix-audio-button";
import { needsAudioFix } from "@/lib/scan/codec-support";
import { DetailHero } from "@/components/library/detail-hero";
import { SeasonEpisodes, type EpisodeRowData } from "@/components/library/season-episodes";

export default async function ShowDetailPage({
  params,
}: PageProps<"/s/[serverId]/show/[id]">) {
  const { serverId, id } = await params;
  const { viewer, role } = await requireServerMember(serverId);

  const [show] = await db
    .select({ show: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(libraries.serverId, serverId)))
    .limit(1)
    .then((rows) => rows.map((r) => r.show));
  if (!show || !isAllowed(viewer, show.ratingAges)) notFound();
  // Symmetric with the movie page redirecting the other way.
  if (show.kind === "movie") redirect(`/s/${serverId}/title/${id}`);

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
  for (const f of segments) {
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

  const totalEpisodes = allEpisodes.length;

  return (
    <div className="flex flex-col gap-8">
      <DetailHero
        kind="show"
        title={show.name}
        backdropUrl={show.backdropUrl}
        posterUrl={show.posterUrl}
        externalRatings={{ imdbRating: show.imdbRating, rottenTomatoesScore: show.rottenTomatoesScore }}
        genres={show.genres}
        overview={show.overview}
        meta={[
          show.year ? String(show.year) : null,
          displayCertification(show.certifications, countryFromLocale(viewer.locale)),
          `${allSeasons.length} season${allSeasons.length === 1 ? "" : "s"}`,
          totalEpisodes > 0 && `${totalEpisodes} episode${totalEpisodes === 1 ? "" : "s"}`,
        ]}
      >
        {nextRow?.ready && nextLabel && (
          <Button
            render={<Link href={`/s/${serverId}/watch/episode/${nextRow.id}`} />}
            className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
          >
            <Play className="size-5" fill="currentColor" />
            {nextLabel}
          </Button>
        )}
        {role === "admin" && <TitleResyncButton titleId={show.id} titleName={show.name} />}
        {role === "admin" && needsAudioFix(segments) && <FixAudioButton titleId={show.id} titleName={show.name} />}
      </DetailHero>

      <SeasonEpisodes
        serverId={serverId}
        seasons={allSeasons.map((s) => ({ id: s.id, number: s.number }))}
        episodes={rows}
        initialSeasonId={nextRow?.seasonId ?? allSeasons[0]?.id ?? ""}
      />
    </div>
  );
}
