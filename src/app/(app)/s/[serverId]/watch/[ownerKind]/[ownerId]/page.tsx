import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { SeamlessPlayer } from "@/components/player/seamless-player";

async function loadMovie(serverId: string, id: string) {
  const [title] = await db
    .select({ title: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(
      and(eq(titles.id, id), eq(titles.kind, "movie"), eq(libraries.serverId, serverId))
    )
    .limit(1)
    .then((rows) => rows.map((r) => r.title));
  if (!title) return null;
  return {
    displayTitle: title.name,
    subtitle: title.year ? String(title.year) : null,
    backHref: `/s/${serverId}/title/${title.id}`,
    nextHref: undefined,
    nextLabel: undefined,
  };
}

async function loadEpisode(serverId: string, id: string) {
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
    .where(and(eq(episodes.id, id), eq(libraries.serverId, serverId)))
    .limit(1);
  if (!row) return null;

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
    backHref: `/s/${serverId}/show/${row.show.id}`,
    nextHref: nextEpisodeId ? `/s/${serverId}/watch/episode/${nextEpisodeId}` : undefined,
    nextLabel,
  };
}

export default async function WatchPage({
  params,
}: PageProps<"/s/[serverId]/watch/[ownerKind]/[ownerId]">) {
  const { serverId, ownerKind, ownerId } = await params;
  await requireServerMember(serverId);

  if (ownerKind !== "title" && ownerKind !== "episode") notFound();

  const loaded =
    ownerKind === "title"
      ? await loadMovie(serverId, ownerId)
      : await loadEpisode(serverId, ownerId);
  if (!loaded) notFound();

  return (
    <SeamlessPlayer
      ownerKind={ownerKind}
      ownerId={ownerId}
      title={loaded.displayTitle}
      subtitle={loaded.subtitle}
      backHref={loaded.backHref}
      nextHref={loaded.nextHref}
      nextLabel={loaded.nextLabel}
    />
  );
}
