import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, seasons, titles } from "@/lib/db/schema";
import { requireProfile } from "@/lib/auth/guards";
import { SeamlessPlayer } from "@/components/player/seamless-player";

async function loadMovie(id: string) {
  const [title] = await db
    .select()
    .from(titles)
    .where(and(eq(titles.id, id), eq(titles.kind, "movie")))
    .limit(1);
  if (!title) return null;
  return { displayTitle: title.name, nextHref: undefined, nextLabel: undefined };
}

async function loadEpisode(id: string) {
  const [row] = await db
    .select({
      episode: episodes,
      season: seasons,
      show: titles,
    })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .where(eq(episodes.id, id))
    .limit(1);
  if (!row) return null;

  const displayTitle = `${row.show.name} — S${row.season.number}E${row.episode.number}${
    row.episode.name ? ` "${row.episode.name}"` : ""
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
    nextHref: nextEpisodeId ? `/watch/episode/${nextEpisodeId}` : undefined,
    nextLabel,
  };
}

export default async function WatchPage({
  params,
}: PageProps<"/watch/[ownerKind]/[ownerId]">) {
  const { ownerKind, ownerId } = await params;
  await requireProfile();

  if (ownerKind !== "title" && ownerKind !== "episode") notFound();

  const loaded = ownerKind === "title" ? await loadMovie(ownerId) : await loadEpisode(ownerId);
  if (!loaded) notFound();

  return (
    <div className="flex flex-col">
      <SeamlessPlayer
        ownerKind={ownerKind}
        ownerId={ownerId}
        title={loaded.displayTitle}
        nextHref={loaded.nextHref}
        nextLabel={loaded.nextLabel}
      />
    </div>
  );
}
