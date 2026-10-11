import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles } from "@/lib/db/schema";
import { loadExtraForWatch } from "@/lib/extras/load";
import { EXTRA_LABELS } from "@/lib/extras/categories";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor, libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { isAllowed } from "@/lib/content/access";
import { isUuid } from "@/lib/playlists/http";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { queueNext } from "@/lib/playlists/next";
import { WatchSession } from "@/components/player/watch-session";

async function loadMovie(lib: LibraryActor, id: string) {
  const title = await db
    .select({ title: titles, libraryKind: libraries.kind })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(
      and(eq(titles.id, id), eq(titles.kind, "movie"), libraryVisible(db, lib))
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (!title) return null;
  const libraryKind = title.libraryKind;
  const movie = title.title;
  return {
    displayTitle: movie.name,
    subtitle: movie.year ? String(movie.year) : null,
    // A video in a photo library has no details page worth going back to: back is the library's timeline.
    backHref: isPhotoLibraryKind(libraryKind) ? `/s/${lib.serverId}/library/${movie.libraryId}` : `/s/${lib.serverId}/title/${movie.id}`,
    nextHref: undefined,
    nextLabel: undefined,
    ratingAges: movie.ratingAges,
  };
}

/** A trailer or other extra of a movie: plays like the movie does, back goes to the movie, and nothing is remembered. */
async function loadExtra(lib: LibraryActor, id: string) {
  const row = await loadExtraForWatch(db, lib, id);
  if (!row) return null;
  return {
    displayTitle: row.extra.name,
    subtitle: `${row.movie.name} · ${EXTRA_LABELS[row.extra.category]}`,
    backHref: `/s/${lib.serverId}/title/${row.movie.id}`,
    nextHref: undefined,
    nextLabel: undefined,
    ratingAges: row.movie.ratingAges,
  };
}

async function loadEpisode(lib: LibraryActor, id: string) {
  const [row] = await db
    .select({
      episode: episodes,
      season: seasons,
      show: titles,
    })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(episodes.id, id), libraryVisible(db, lib)))
    .limit(1);
  if (!row) return null;

  const ratingAges = row.show.ratingAges;
  const displayTitle = row.show.name;
  const subtitle = `S${row.season.number} · E${row.episode.number}${
    row.episode.name ? ` · ${row.episode.name}` : ""
  }`;

  // Next episode: same season, next number; else first episode of the next season.
  const [nextInSeason] = await db
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.seasonId, row.season.id), gt(episodes.number, row.episode.number)))
    .orderBy(asc(episodes.number))
    .limit(1);

  let nextEpisodeId = nextInSeason?.id;
  let nextLabel = "Play next episode";

  if (!nextEpisodeId) {
    const [nextSeason] = await db
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.titleId, row.show.id), gt(seasons.number, row.season.number)))
      .orderBy(asc(seasons.number))
      .limit(1);
    if (nextSeason) {
      const [firstEpisode] = await db
        .select({ id: episodes.id })
        .from(episodes)
        .where(eq(episodes.seasonId, nextSeason.id))
        .orderBy(asc(episodes.number))
        .limit(1);
      nextEpisodeId = firstEpisode?.id;
      nextLabel = "Play next season";
    }
  }

  return {
    displayTitle,
    subtitle,
    backHref: `/s/${lib.serverId}/show/${row.show.id}`,
    nextHref: nextEpisodeId ? `/s/${lib.serverId}/watch/episode/${nextEpisodeId}` : undefined,
    nextLabel,
    ratingAges,
  };
}

export default async function WatchPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/watch/[ownerKind]/[ownerId]">) {
  const { serverId, ownerKind, ownerId } = await params;
  const query = await searchParams;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);

  if (ownerKind !== "title" && ownerKind !== "episode" && ownerKind !== "extra") notFound();

  const loaded =
    ownerKind === "title"
      ? await loadMovie(lib, ownerId)
      : ownerKind === "extra"
        ? await loadExtra(lib, ownerId)
        : await loadEpisode(lib, ownerId);
  // A blocked title 404s exactly like a nonexistent one — see lib/content/access.
  if (!loaded || !isAllowed(viewer, loaded.ratingAges)) notFound();

  // Opened from a playlist ("Play all", or a playlist row)? If the queue context is
  // genuine, the end-card's next link follows the playlist instead of the show; if it
  // isn't (stale, tampered, or not this item), the parameters are simply ignored.
  let nextHref = loaded.nextHref;
  let nextLabel = loaded.nextLabel;
  const playlistId = typeof query.playlist === "string" ? query.playlist : null;
  const itemId = typeof query.item === "string" ? query.item : null;
  if (playlistId && itemId && isUuid(playlistId) && isUuid(itemId)) {
    const queue = await queueNext(db, {
      playlistId,
      itemId,
      viewerId: viewer.id,
      titleId: ownerKind === "title" ? ownerId : undefined,
      episodeId: ownerKind === "episode" ? ownerId : undefined,
      replay: query.replay === "1",
    });
    if (queue.valid) {
      nextHref = queue.next?.href;
      nextLabel = queue.next?.label;
    }
  }

  // Coming back to the full player from the bar must keep the playlist it was opened from (else "next" would change).
  const queueQuery = playlistId && itemId && isUuid(playlistId) && isUuid(itemId) ? `?playlist=${playlistId}&item=${itemId}${query.replay === "1" ? "&replay=1" : ""}` : "";
  // The player itself lives in the server layout (see VideoSessionProvider), so a video can carry on in a floating bar when the viewer
  // browses away; this page just asks for it to fill the screen.
  return (
    <WatchSession
      ownerKind={ownerKind}
      ownerId={ownerId}
      title={loaded.displayTitle}
      subtitle={loaded.subtitle}
      backHref={loaded.backHref}
      nextHref={nextHref}
      nextLabel={nextLabel}
      watchHref={`/s/${serverId}/watch/${ownerKind}/${ownerId}${queueQuery}`}
    />
  );
}
