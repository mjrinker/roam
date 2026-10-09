import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireServerMember } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { episodes, seasons, titles } from "@/lib/db/schema";
import { openSubtitlesConfig } from "@/lib/subtitles/opensubtitles";
import { authorizeSubtitles, parseOwner } from "@/lib/subtitles/http";
import { defaultSubtitleLanguage } from "@/lib/subtitles/languages";
import { listTracks } from "@/lib/subtitles/service";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { SubtitleManager } from "@/components/subtitles/subtitle-manager";

/** The admin's page for one movie, video or episode: its subtitles, finding more on OpenSubtitles, and adding a file of your own. */
export default async function SubtitlesPage({ params }: PageProps<"/s/[serverId]/subtitles/[ownerKind]/[ownerId]">) {
  const { serverId, ownerKind, ownerId } = await params;
  const { viewer } = await requireServerMember(serverId);
  const owner = parseOwner(ownerKind, ownerId);
  if (!owner) notFound();
  // Only the server's admin, and only for something they can see on this server; anyone else gets "not found".
  const access = await authorizeSubtitles(owner, { admin: true });
  if (!access.ok || access.auth.serverId !== serverId) notFound();

  let name = "";
  let backHref = `/s/${serverId}`;
  if (owner.kind === "title") {
    const [t] = await db.select({ name: titles.name }).from(titles).where(eq(titles.id, owner.id)).limit(1);
    name = t?.name ?? "";
    backHref = `/s/${serverId}/title/${owner.id}`;
  } else {
    const [e] = await db
      .select({ show: titles.name, showId: titles.id, season: seasons.number, number: episodes.number, name: episodes.name })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .where(eq(episodes.id, owner.id))
      .limit(1);
    name = e ? `${e.show} · S${e.season} · E${e.number}${e.name ? ` · ${e.name}` : ""}` : "";
    backHref = e ? `/s/${serverId}/show/${e.showId}` : backHref;
  }
  if (!name) notFound();
  const tracks = await listTracks(db, owner);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: name, href: backHref }, { label: "Subtitles" }]} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Subtitles</h1>
        <p className="mt-1 text-muted-foreground">{name}</p>
      </header>
      <SubtitleManager
        ownerKind={owner.kind}
        ownerId={owner.id}
        tracks={tracks}
        openSubtitlesReady={openSubtitlesConfig() !== null}
        defaultLanguage={defaultSubtitleLanguage(viewer.locale)}
        watchHref={`/s/${serverId}/watch/${owner.kind}/${owner.id}`}
      />
    </div>
  );
}
