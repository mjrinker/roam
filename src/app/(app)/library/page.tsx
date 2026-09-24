import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, seasons, titles, watchState } from "@/lib/db/schema";
import { requireProfile } from "@/lib/auth/guards";
import { TitleCard, type TitleCardData } from "@/components/library/title-card";
import {
  ContinueWatchingCard,
  type ContinueWatchingItem,
} from "@/components/library/continue-watching-card";

const CONTINUE_WATCHING_LIMIT = 16;

export default async function LibraryPage() {
  const profile = await requireProfile();

  const allTitles = await db.select().from(titles).orderBy(desc(titles.addedAt));
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

  const inProgressMovies = inProgress.filter(
    (w) => w.ownerKind === "title" && w.durationSeconds && w.positionSeconds > 0
  );
  const inProgressEpisodes = inProgress.filter(
    (w) => w.ownerKind === "episode" && w.durationSeconds && w.positionSeconds > 0
  );

  const progressByTitleId = new Map(
    inProgressMovies.map((w) => [w.ownerId, w.positionSeconds / w.durationSeconds!])
  );

  // Resolve episode display info (show name, season/episode, artwork) for
  // any in-progress episodes, so Continue Watching can show something
  // useful rather than a bare episode id.
  const episodeIds = inProgressEpisodes.map((w) => w.ownerId);
  const episodeDetails = episodeIds.length
    ? await db
        .select({ episode: episodes, season: seasons, show: titles })
        .from(episodes)
        .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
        .innerJoin(titles, eq(seasons.titleId, titles.id))
        .where(inArray(episodes.id, episodeIds))
    : [];
  const episodeDetailsById = new Map(episodeDetails.map((d) => [d.episode.id, d]));

  const movieById = new Map(movies.map((m) => [m.id, m]));

  // inProgress is already sorted by updatedAt desc, across both kinds — map
  // each row to a display item in that same recency order.
  const continueWatching: ContinueWatchingItem[] = inProgress
    .map((w): ContinueWatchingItem | null => {
      if (!w.durationSeconds || w.positionSeconds <= 0) return null;
      const progressFraction = w.positionSeconds / w.durationSeconds;

      if (w.ownerKind === "title") {
        const movie = movieById.get(w.ownerId);
        if (!movie) return null;
        return {
          href: `/watch/title/${movie.id}`,
          posterUrl: movie.posterUrl,
          primaryLabel: movie.name,
          progressFraction,
        };
      }

      const details = episodeDetailsById.get(w.ownerId);
      if (!details) return null;
      return {
        href: `/watch/episode/${w.ownerId}`,
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
      progressFraction: progressByTitleId.get(t.id) ?? null,
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
            No movies yet.{" "}
            {profile.role === "admin"
              ? "Head to Admin to run your first scan."
              : "Ask an admin to add some."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {movies.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} />
            ))}
          </div>
        )}
      </section>

      {shows.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">TV Shows</h2>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {shows.map((t) => (
              <TitleCard key={t.id} title={toCard(t)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
