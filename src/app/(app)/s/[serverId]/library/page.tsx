import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import {
  ContinueWatchingCard,
  type ContinueWatchingItem,
} from "@/components/library/continue-watching-card";

const CONTINUE_WATCHING_LIMIT = 16;

export default async function LibraryHomePage({
  params,
}: PageProps<"/s/[serverId]/library">) {
  const { serverId } = await params;
  const { profile } = await requireServerMember(serverId);

  const hasAnyLibrary = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .limit(1);

  const inProgress = await db
    .select()
    .from(watchState)
    .where(and(eq(watchState.profileId, profile.id), eq(watchState.finished, false)))
    .orderBy(desc(watchState.updatedAt))
    .limit(CONTINUE_WATCHING_LIMIT);

  const inProgressMovies = inProgress.filter(
    (w) => w.ownerKind === "title" && w.durationSeconds && w.positionSeconds > 0
  );
  const inProgressEpisodes = inProgress.filter(
    (w) => w.ownerKind === "episode" && w.durationSeconds && w.positionSeconds > 0
  );

  // Resolve display info scoped to THIS server, so a profile in progress
  // on a different server never bleeds into this page.
  const movieIds = inProgressMovies.map((w) => w.ownerId);
  const movieDetails = movieIds.length
    ? await db
        .select({ title: titles })
        .from(titles)
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(titles.id, movieIds), eq(libraries.serverId, serverId)))
    : [];
  const movieById = new Map(movieDetails.map((d) => [d.title.id, d.title]));

  const episodeIds = inProgressEpisodes.map((w) => w.ownerId);
  const episodeDetails = episodeIds.length
    ? await db
        .select({ episode: episodes, season: seasons, show: titles })
        .from(episodes)
        .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
        .innerJoin(titles, eq(seasons.titleId, titles.id))
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(episodes.id, episodeIds), eq(libraries.serverId, serverId)))
    : [];
  const episodeDetailsById = new Map(episodeDetails.map((d) => [d.episode.id, d]));

  const continueWatching: ContinueWatchingItem[] = inProgress
    .map((w): ContinueWatchingItem | null => {
      if (!w.durationSeconds || w.positionSeconds <= 0) return null;
      const progressFraction = w.positionSeconds / w.durationSeconds;

      if (w.ownerKind === "title") {
        const movie = movieById.get(w.ownerId);
        if (!movie) return null;
        return {
          href: `/s/${serverId}/watch/title/${movie.id}`,
          posterUrl: movie.posterUrl,
          primaryLabel: movie.name,
          progressFraction,
        };
      }

      const details = episodeDetailsById.get(w.ownerId);
      if (!details) return null;
      return {
        href: `/s/${serverId}/watch/episode/${w.ownerId}`,
        posterUrl: details.episode.stillUrl ?? details.show.posterUrl,
        primaryLabel: details.show.name,
        secondaryLabel: `S${details.season.number}E${details.episode.number}${
          details.episode.name ? ` · ${details.episode.name}` : ""
        }`,
        progressFraction,
      };
    })
    .filter((x): x is ContinueWatchingItem => x !== null);

  return (
    <div className="flex flex-col gap-10 px-6 py-8">
      {continueWatching.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Continue Watching</h2>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {continueWatching.map((item) => (
              <ContinueWatchingCard key={item.href} item={item} />
            ))}
          </div>
        </section>
      )}

      {hasAnyLibrary.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No libraries yet. Head to Admin to connect Box and add one.
        </p>
      ) : continueWatching.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Pick a library from the sidebar to start browsing.
        </p>
      ) : null}
    </div>
  );
}
