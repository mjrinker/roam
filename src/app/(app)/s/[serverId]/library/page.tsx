import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { TitleCard, type TitleCardData } from "@/components/library/title-card";
import {
  ContinueWatchingCard,
  type ContinueWatchingItem,
} from "@/components/library/continue-watching-card";

const CONTINUE_WATCHING_LIMIT = 16;

export default async function LibraryPage({
  params,
}: PageProps<"/s/[serverId]/library">) {
  const { serverId } = await params;
  const { profile } = await requireServerMember(serverId);

  const allTitles = await db
    .select({
      id: titles.id,
      kind: titles.kind,
      name: titles.name,
      year: titles.year,
      posterUrl: titles.posterUrl,
      runtimeSeconds: titles.runtimeSeconds,
      addedAt: titles.addedAt,
    })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(libraries.serverId, serverId))
    .orderBy(desc(titles.addedAt));
  const movies = allTitles.filter((t) => t.kind === "movie");
  const shows = allTitles.filter((t) => t.kind === "show");

  const inProgress = await db
    .select()
    .from(watchState)
    .where(
      and(eq(watchState.profileId, profile.id), eq(watchState.finished, false))
    )
    .orderBy(desc(watchState.updatedAt))
    .limit(CONTINUE_WATCHING_LIMIT);

  const inProgressEpisodes = inProgress.filter(
    (w) => w.ownerKind === "episode" && w.durationSeconds && w.positionSeconds > 0
  );

  // Resolve episode display info (show name, season/episode, artwork) for
  // in-progress episodes — scoped to THIS server's shows, so a profile
  // watching something on a different server never bleeds into this page.
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

  const movieById = new Map(movies.map((m) => [m.id, m]));

  // inProgress is already sorted by updatedAt desc, across both kinds — map
  // each row to a display item in that same recency order. A row whose
  // owner isn't found in either map belongs to a different server (this
  // profile can be a member of several) and is silently skipped.
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

  function toCard(t: (typeof allTitles)[number]): TitleCardData {
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      year: t.year,
      posterUrl: t.posterUrl,
      runtimeSeconds: t.runtimeSeconds,
    };
  }

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

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Movies</h2>
        {movies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No movies yet. Head to Admin to add a library and scan it.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {movies.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} serverId={serverId} />
            ))}
          </div>
        )}
      </section>

      {shows.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">TV Shows</h2>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {shows.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} serverId={serverId} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
