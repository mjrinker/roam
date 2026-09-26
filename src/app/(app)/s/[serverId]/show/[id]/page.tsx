import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

function formatRuntime(totalSeconds: number | null) {
  if (!totalSeconds) return null;
  const minutes = Math.round(totalSeconds / 60);
  return `${minutes}m`;
}

export default async function ShowDetailPage({
  params,
}: PageProps<"/s/[serverId]/show/[id]">) {
  const { serverId, id } = await params;
  const { profile } = await requireServerMember(serverId);

  const [show] = await db
    .select({ show: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(libraries.serverId, serverId)))
    .limit(1)
    .then((rows) => rows.map((r) => r.show));
  if (!show) notFound();
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
              eq(watchState.profileId, profile.id),
              eq(watchState.ownerKind, "episode"),
              inArray(watchState.ownerId, episodeIds)
            )
          )
      : Promise.resolve([]),
  ]);

  const readyByEpisode = new Map<string, boolean>();
  for (const episodeId of episodeIds) {
    const rows = segments.filter((s) => s.ownerId === episodeId);
    readyByEpisode.set(episodeId, rows.length > 0 && rows.every((r) => r.durationSeconds != null));
  }
  const stateByEpisode = new Map(states.map((s) => [s.ownerId, s]));

  const episodesBySeason = new Map<string, typeof allEpisodes>();
  for (const ep of allEpisodes) {
    const list = episodesBySeason.get(ep.seasonId) ?? [];
    list.push(ep);
    episodesBySeason.set(ep.seasonId, list);
  }

  return (
    <div className="relative">
      {show.backdropUrl && (
        <div className="absolute inset-x-0 top-0 h-[420px] overflow-hidden">
          <Image
            src={show.backdropUrl}
            alt=""
            fill
            priority
            className="object-cover opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          />
        </div>
      )}

      <div className="relative flex flex-col gap-6 px-6 py-10 sm:flex-row">
        <div className="w-48 shrink-0 overflow-hidden rounded-md bg-muted shadow-lg sm:w-64">
          {show.posterUrl ? (
            <Image
              src={show.posterUrl}
              alt={show.name}
              width={256}
              height={384}
              className="h-auto w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[2/3] items-center justify-center p-4 text-center text-sm text-muted-foreground">
              {show.name}
            </div>
          )}
        </div>

        <div className="flex max-w-2xl flex-col gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{show.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {show.year && <span>{show.year}</span>}
              <span>&middot;</span>
              <span>
                {allSeasons.length} season{allSeasons.length === 1 ? "" : "s"}
              </span>
            </div>
            {show.genres && show.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {show.genres.map((g) => (
                  <Badge key={g} variant="outline">
                    {g}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {show.overview && (
            <p className="text-sm leading-relaxed text-muted-foreground">{show.overview}</p>
          )}
        </div>
      </div>

      <div className="relative flex flex-col gap-8 px-6 pb-12">
        {allSeasons.length === 0 && (
          <p className="text-sm text-muted-foreground">No seasons found yet.</p>
        )}
        {allSeasons.map((season) => (
          <section key={season.id} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Season {season.number}</h2>
            <Separator />
            <div className="flex flex-col divide-y divide-border">
              {(episodesBySeason.get(season.id) ?? []).map((ep) => {
                const ready = readyByEpisode.get(ep.id) ?? false;
                const state = stateByEpisode.get(ep.id);
                const hasProgress = !!state && !state.finished && state.positionSeconds > 0;
                return (
                  <div key={ep.id} className="flex items-center gap-4 py-3">
                    <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-muted">
                      {ep.stillUrl && (
                        <Image src={ep.stillUrl} alt="" fill className="object-cover" />
                      )}
                      {hasProgress && state?.durationSeconds && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
                          <div
                            className="h-full bg-primary"
                            style={{
                              width: `${Math.min(100, (state.positionSeconds / state.durationSeconds) * 100)}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {ep.number}. {ep.name ?? `Episode ${ep.number}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRuntime(ep.runtimeSeconds)}
                      </p>
                      {ep.overview && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {ep.overview}
                        </p>
                      )}
                    </div>
                    {ready ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        render={<Link href={`/s/${serverId}/watch/episode/${ep.id}`} />}
                      >
                        {hasProgress ? "Resume" : "Play"}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" disabled>
                        Not ready
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
