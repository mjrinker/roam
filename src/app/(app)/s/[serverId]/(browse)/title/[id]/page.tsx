import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { Loader2, Play } from "lucide-react";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { formatRemaining, formatRuntime } from "@/lib/format";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { Button } from "@/components/ui/button";
import { TitleResyncButton } from "@/components/admin/title-resync-button";
import { DetailHero } from "@/components/library/detail-hero";

export default async function TitleDetailPage({
  params,
}: PageProps<"/s/[serverId]/title/[id]">) {
  const { serverId, id } = await params;
  const { viewer, role } = await requireServerMember(serverId);

  // Join through libraries so a title id from a DIFFERENT server 404s here,
  // rather than trusting the bare id from the URL.
  const [title] = await db
    .select({ title: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(libraries.serverId, serverId)))
    .limit(1)
    .then((rows) => rows.map((r) => r.title));
  if (!title) notFound();
  // This page is movie-only; shows have their own season/episode browser.
  if (title.kind === "show") redirect(`/s/${serverId}/show/${id}`);

  const segments = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id)))
    .orderBy(asc(mediaFiles.partIndex));

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
      genres={title.genres}
      overview={title.overview}
      meta={[
        title.year ? String(title.year) : null,
        displayCertification(title.certifications, countryFromLocale(viewer.locale)),
        formatRuntime(title.runtimeSeconds),
        segments.length > 1 && `${segments.length} parts, plays as one`,
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
      {role === "admin" && <TitleResyncButton titleId={title.id} titleName={title.name} />}
    </DetailHero>
  );
}
