import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function formatRuntime(totalSeconds: number | null) {
  if (!totalSeconds) return null;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export default async function TitleDetailPage({
  params,
}: PageProps<"/s/[serverId]/title/[id]">) {
  const { serverId, id } = await params;
  const { profile } = await requireServerMember(serverId);

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
        eq(watchState.profileId, profile.id),
        eq(watchState.ownerKind, "title"),
        eq(watchState.ownerId, id)
      )
    )
    .limit(1);

  const ready = segments.length > 0 && segments.every((s) => s.durationSeconds != null);
  const hasProgress = !!state && !state.finished && state.positionSeconds > 0;

  return (
    <div className="relative">
      {title.backdropUrl && (
        <div className="absolute inset-x-0 top-0 h-[420px] overflow-hidden">
          <Image
            src={title.backdropUrl}
            alt=""
            fill
            priority
            className="object-cover opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          />
        </div>
      )}

      <div className="relative flex flex-col gap-6 px-6 py-10 sm:flex-row">
        <div className="w-48 shrink-0 overflow-hidden rounded-md bg-muted shadow-lg sm:w-64">
          {title.posterUrl ? (
            <Image
              src={title.posterUrl}
              alt={title.name}
              width={256}
              height={384}
              className="h-auto w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[2/3] items-center justify-center p-4 text-center text-sm text-muted-foreground">
              {title.name}
            </div>
          )}
        </div>

        <div className="flex max-w-2xl flex-col gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{title.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {title.year && <span>{title.year}</span>}
              {title.runtimeSeconds && (
                <>
                  <span>&middot;</span>
                  <span>{formatRuntime(title.runtimeSeconds)}</span>
                </>
              )}
              {segments.length > 1 && (
                <Badge variant="secondary">{segments.length} parts</Badge>
              )}
            </div>
            {title.genres && title.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {title.genres.map((g) => (
                  <Badge key={g} variant="outline">
                    {g}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {title.overview && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {title.overview}
            </p>
          )}

          <div className="flex items-center gap-3">
            {ready ? (
              <Button
                render={<Link href={`/s/${serverId}/watch/title/${title.id}`} />}
                size="lg"
              >
                {hasProgress ? "Resume" : "Play"}
              </Button>
            ) : (
              <Button size="lg" disabled>
                Still processing…
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
