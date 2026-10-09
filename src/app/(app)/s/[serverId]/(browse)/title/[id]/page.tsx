import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { Loader2, Play } from "lucide-react";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { defaultVersionRows } from "@/lib/player/versions";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { isAllowed } from "@/lib/content/access";
import { formatRemaining, formatRuntime } from "@/lib/format";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { Button } from "@/components/ui/button";
import { TitleResyncButton } from "@/components/admin/title-resync-button";
import { TmdbMatchButton } from "@/components/admin/tmdb-match-button";
import { FixAudioButton } from "@/components/admin/fix-audio-button";
import { needsAudioFix } from "@/lib/scan/codec-support";
import { DetailHero } from "@/components/library/detail-hero";
import { AddToPlaylistMenu } from "@/components/playlists/add-to-playlist-menu";
import { MarkDoneButton } from "@/components/library/mark-done-button";
import { MoreMenu } from "@/components/shell/more-menu";
import { DownloadButton } from "@/components/offline/download-button";
import { libraryHasDoneState } from "@/lib/libraries/profile";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";

export default async function TitleDetailPage({
  params,
}: PageProps<"/s/[serverId]/title/[id]">) {
  const { serverId, id } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);

  // Join through libraries so a title id from a DIFFERENT server 404s here,
  // rather than trusting the bare id from the URL.
  const [row] = await db
    .select({ title: titles, libraryId: libraries.id, libraryName: libraries.name, libraryKind: libraries.kind })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), libraryVisible(db, lib)))
    .limit(1);
  const title = row?.title;
  // Videos in a video library have no TMDB match to fix and aren't resynced by folder.
  const isGeneric = isFileTreeLibraryKind(row?.libraryKind);
  if (!title || !isAllowed(viewer, title.ratingAges)) notFound();
  // This page is movie-only; shows have their own season/episode browser.
  if (title.kind === "show") redirect(`/s/${serverId}/show/${id}`);
  // Photos have their own viewer, and an audiobook its book page; this page is for things that play as a movie.
  if (title.kind === "photo") notFound();
  if (title.kind === "audiobook") redirect(`/s/${serverId}/book/${id}`);
  if (title.kind === "ebook") redirect(`/s/${serverId}/ebook/${id}`);

  // A movie saved in several resolutions is the same movie: this page looks at the one that plays by default.
  const segments = defaultVersionRows(
    await db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id)))
      .orderBy(asc(mediaFiles.partIndex))
  );

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.viewerId, viewer.id),
        eq(watchState.ownerKind, "title"),
        eq(watchState.ownerId, id)
      )
    )
    .limit(1);

  const ready = segments.length > 0 && segments.every((s) => s.durationSeconds != null);
  const hasProgress = !!state && !state.finished && state.positionSeconds > 0;
  const noFiles = segments.length === 0;
  const remaining =
    hasProgress && state.durationSeconds
      ? formatRemaining(state.durationSeconds, state.positionSeconds)
      : null;
  const progressFraction =
    hasProgress && state.durationSeconds ? state.positionSeconds / state.durationSeconds : 0;

  return (
    <DetailHero
      kind="movie"
      title={title.name}
      backdropUrl={title.backdropUrl}
      posterUrl={title.posterUrl}
      externalRatings={{ imdbRating: title.imdbRating, rottenTomatoesScore: title.rottenTomatoesScore }}
      genres={title.genres}
      overview={title.overview}
      breadcrumbs={
        <Breadcrumbs
          serverId={serverId}
          trail={[
            { label: row.libraryName, href: `/s/${serverId}/library/${row.libraryId}` },
            { label: title.name },
          ]}
        />
      }
      meta={[
        title.year ? String(title.year) : null,
        displayCertification(title.certifications, countryFromLocale(viewer.locale)),
        formatRuntime(title.runtimeSeconds),
      ]}
    >
      {ready ? (
        <div className="flex flex-col items-center gap-2 md:items-start">
          <Button
            render={<Link href={`/s/${serverId}/watch/title/${title.id}`} />}
            className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
          >
            <Play className="size-5" fill="currentColor" />
            {hasProgress ? "Resume" : "Play"}
          </Button>
          {hasProgress && (
            <div className="flex w-full items-center gap-2.5 text-xs text-muted-foreground">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, progressFraction * 100)}%` }}
                />
              </div>
              {remaining}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-white/[0.06] px-4 py-3 text-sm ring-1 ring-white/10">
          {noFiles ? null : <Loader2 className="size-4 animate-spin text-primary" />}
          <span className="text-foreground/80">
            {noFiles
              ? "No playable video found in this title's folder yet."
              : "Getting this title ready to play…"}
          </span>
        </div>
      )}
      <AddToPlaylistMenu serverId={serverId} target={{ titleId: title.id }} />
      <MoreMenu>
        {ready && <DownloadButton serverId={serverId} ownerKind="title" ownerId={title.id} />}
        {libraryHasDoneState(row.libraryKind) && <MarkDoneButton kind="title" id={title.id} done={!!state?.finished} media="watch" />}
        {role === "admin" && !isGeneric && <TitleResyncButton titleId={title.id} titleName={title.name} />}
        {role === "admin" && !isGeneric && <TmdbMatchButton titleId={title.id} titleName={title.name} kind="movie" />}
        {role === "admin" && !isGeneric && needsAudioFix(segments) && <FixAudioButton titleId={title.id} titleName={title.name} />}
      </MoreMenu>
    </DetailHero>
  );
}
