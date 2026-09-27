import Link from "next/link";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { FolderPlus, Library } from "lucide-react";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { formatRemaining } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { HeroBanner, type HeroBannerData } from "@/components/library/hero-banner";
import { LandscapeCard, type LandscapeCardData } from "@/components/library/landscape-card";
import { MediaRow } from "@/components/library/media-row";
import { PosterCard, type PosterCardData } from "@/components/library/poster-card";
import { CONTINUE_LISTENING_MIN_SECONDS } from "@/lib/player/timeline";
import { contentFilter } from "@/lib/content/access";

const CONTINUE_WATCHING_LIMIT = 16;
const RECENTLY_ADDED_LIMIT = 20;

export default async function LibraryHomePage({
  params,
}: PageProps<"/s/[serverId]/library">) {
  const { serverId } = await params;
  const { viewer, role } = await requireServerMember(serverId);

  const serverLibraries = await db
    .select()
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .orderBy(asc(libraries.name));

  const inProgress = await db
    .select()
    .from(watchState)
    .where(and(eq(watchState.viewerId, viewer.id), eq(watchState.finished, false)))
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
        .where(
          and(inArray(titles.id, movieIds), eq(libraries.serverId, serverId), contentFilter(viewer, titles.ratingAges))
        )
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
        .where(
          and(
            inArray(episodes.id, episodeIds),
            eq(libraries.serverId, serverId),
            contentFilter(viewer, titles.ratingAges)
          )
        )
    : [];
  const episodeDetailsById = new Map(episodeDetails.map((d) => [d.episode.id, d]));

  const continueWatching: (LandscapeCardData & { hero: HeroBannerData })[] = [];
  for (const w of inProgress) {
    if (!w.durationSeconds || w.positionSeconds <= 0) continue;
    const progressFraction = w.positionSeconds / w.durationSeconds;
    const remainingLabel = formatRemaining(w.durationSeconds, w.positionSeconds);

    if (w.ownerKind === "title") {
      const movie = movieById.get(w.ownerId);
      if (!movie) continue;
      // Audiobooks have their own "Continue Listening" row below.
      if (movie.kind === "audiobook") continue;
      const href = `/s/${serverId}/watch/title/${movie.id}`;
      continueWatching.push({
        href,
        imageUrl: movie.backdropUrl ?? movie.posterUrl,
        primaryLabel: movie.name,
        secondaryLabel: movie.year ? String(movie.year) : null,
        progressFraction,
        remainingLabel,
        hero: {
          backdropUrl: movie.backdropUrl,
          eyebrow: "Continue watching",
          title: movie.name,
          subtitle: [movie.year, remainingLabel].filter(Boolean).join(" · "),
          overview: movie.overview,
          primaryHref: href,
          primaryLabel: "Resume",
          detailsHref: `/s/${serverId}/title/${movie.id}`,
          progressFraction,
        },
      });
      continue;
    }

    const details = episodeDetailsById.get(w.ownerId);
    if (!details) continue;
    const href = `/s/${serverId}/watch/episode/${w.ownerId}`;
    const episodeLabel = `S${details.season.number} · E${details.episode.number}${
      details.episode.name ? ` · ${details.episode.name}` : ""
    }`;
    continueWatching.push({
      href,
      imageUrl: details.episode.stillUrl ?? details.show.backdropUrl ?? details.show.posterUrl,
      primaryLabel: details.show.name,
      secondaryLabel: `S${details.season.number} · E${details.episode.number}`,
      progressFraction,
      remainingLabel,
      hero: {
        backdropUrl: details.show.backdropUrl,
        eyebrow: "Continue watching",
        title: details.show.name,
        subtitle: [episodeLabel, remainingLabel].filter(Boolean).join(" · "),
        overview: details.episode.overview ?? details.show.overview,
        primaryHref: href,
        primaryLabel: "Resume",
        detailsHref: `/s/${serverId}/show/${details.show.id}`,
        progressFraction,
      },
    });
  }

  const continueListening: PosterCardData[] = [];
  for (const w of inProgress) {
    if (w.ownerKind !== "title" || !w.durationSeconds || w.positionSeconds < CONTINUE_LISTENING_MIN_SECONDS) continue;
    const book = movieById.get(w.ownerId);
    if (!book || book.kind !== "audiobook") continue;
    continueListening.push({
      id: book.id,
      kind: book.kind,
      name: book.name,
      year: book.year,
      subtitle: formatRemaining(w.durationSeconds, w.positionSeconds),
      posterUrl: book.posterUrl,
      progressFraction: w.positionSeconds / w.durationSeconds,
    });
  }

  const recentByLibrary = await Promise.all(
    serverLibraries.map(async (library) => ({
      library,
      items: await db
        .select()
        .from(titles)
        .where(and(eq(titles.libraryId, library.id), contentFilter(viewer, titles.ratingAges)))
        .orderBy(desc(titles.addedAt))
        .limit(RECENTLY_ADDED_LIMIT),
    }))
  );

  // Hero: whatever you were last watching, else the newest title with a
  // backdrop to show off.
  let hero: HeroBannerData | null = continueWatching[0]?.hero ?? null;
  if (!hero) {
    const newest = recentByLibrary
      .flatMap((r) => r.items)
      .filter((t) => t.backdropUrl)
      .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())[0];
    if (newest) {
      const detailsHref =
        newest.kind === "show"
          ? `/s/${serverId}/show/${newest.id}`
          : `/s/${serverId}/title/${newest.id}`;
      hero = {
        backdropUrl: newest.backdropUrl,
        eyebrow: "Recently added",
        title: newest.name,
        subtitle: [newest.year, newest.kind === "show" ? "TV Show" : "Movie"]
          .filter(Boolean)
          .join(" · "),
        overview: newest.overview,
        primaryHref: detailsHref,
        primaryLabel: newest.kind === "show" ? "View show" : "View details",
      };
    }
  }

  const hasContent = recentByLibrary.some((r) => r.items.length > 0);

  return (
    <div className="flex flex-col pb-16">
      {hero && <HeroBanner hero={hero} />}

      <div className={hero ? "flex flex-col gap-10 pt-2" : "flex flex-col gap-10 pt-8"}>
        {continueWatching.length > 0 && (
          <MediaRow title="Continue Watching">
            {continueWatching.map((item) => (
              <LandscapeCard key={item.href} item={item} className="w-64 sm:w-72" />
            ))}
          </MediaRow>
        )}

        {continueListening.length > 0 && (
          <MediaRow title="Continue Listening">
            {continueListening.map((book) => (
              <PosterCard key={book.id} serverId={serverId} title={book} className="w-36 sm:w-40 lg:w-44" />
            ))}
          </MediaRow>
        )}

        {recentByLibrary
          .filter((r) => r.items.length > 0)
          .map(({ library, items }) => (
            <MediaRow
              key={library.id}
              title={`Recently Added · ${library.name}`}
              href={`/s/${serverId}/library/${library.id}`}
            >
              {items.map((t) => (
                <PosterCard
                  key={t.id}
                  serverId={serverId}
                  className="w-36 sm:w-40 lg:w-44"
                  title={{
                    id: t.id,
                    kind: t.kind,
                    name: t.name,
                    year: t.year,
                    subtitle:
                      t.kind === "audiobook"
                        ? ((t.authors?.length ? t.authors : [t.folderAuthor]).filter(Boolean).join(", ") || null)
                        : null,
                    posterUrl: t.posterUrl,
                  }}
                />
              ))}
            </MediaRow>
          ))}

        {!hasContent && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center">
            <span className="flex size-16 items-center justify-center rounded-2xl bg-white/[0.06] ring-1 ring-white/10">
              {serverLibraries.length === 0 ? (
                <FolderPlus className="size-7 text-primary" />
              ) : (
                <Library className="size-7 text-primary" />
              )}
            </span>
            <h2 className="text-xl font-semibold tracking-tight">
              {serverLibraries.length === 0 ? "Let's add your first library" : "Nothing here yet"}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {serverLibraries.length === 0
                ? role === "admin"
                  ? "Connect Box, pick a folder of movies or shows, and Roam will scan it and pull in posters and details."
                  : "This server doesn't have any libraries yet. Ask an admin to add one."
                : role === "admin"
                  ? "Your libraries haven't been scanned yet. Run a scan from server settings."
                  : "Titles will show up here as soon as the first scan finishes."}
            </p>
            {role === "admin" && (
              <Button render={<Link href={`/s/${serverId}/admin`} />} className="rounded-xl">
                Open server settings
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
