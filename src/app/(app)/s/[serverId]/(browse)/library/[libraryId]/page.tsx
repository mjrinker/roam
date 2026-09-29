import Link from "next/link";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Film, Headphones, Tv } from "lucide-react";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { contentFilter } from "@/lib/content/access";
import { Button } from "@/components/ui/button";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import {
  LibraryBrowser,
  type LibraryBrowserItem,
} from "@/components/library/library-browser";

export default async function LibraryDetailPage({
  params,
}: PageProps<"/s/[serverId]/library/[libraryId]">) {
  const { serverId, libraryId } = await params;
  const { viewer, role } = await requireServerMember(serverId);

  // Confirm the library actually belongs to this server before showing
  // anything — don't trust the bare id from the URL.
  const [library] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.serverId, serverId)))
    .limit(1);
  if (!library) notFound();

  // A library's titles are homogeneous in kind (movies|shows) — the
  // scanner only ever writes one kind of title into a given library.
  const libraryTitles = await db
    .select()
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), contentFilter(viewer, titles.ratingAges)))
    .orderBy(asc(titles.name));

  // Per-profile watch progress and "still processing" flags — for titles that
  // own their files directly (movies, audiobooks); a show's status depends on
  // its episodes and isn't summarized here.
  const movieIds = library.kind !== "shows" ? libraryTitles.map((t) => t.id) : [];
  const [states, fileStats] = movieIds.length
    ? await Promise.all([
        db
          .select()
          .from(watchState)
          .where(
            and(
              eq(watchState.viewerId, viewer.id),
              eq(watchState.ownerKind, "title"),
              inArray(watchState.ownerId, movieIds)
            )
          ),
        db
          .select({
            ownerId: mediaFiles.ownerId,
            total: count(),
            probed: count(mediaFiles.durationSeconds),
          })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, movieIds)))
          .groupBy(mediaFiles.ownerId),
      ])
    : [[], []];
  const stateById = new Map(states.map((s) => [s.ownerId, s]));
  const statsById = new Map(fileStats.map((s) => [s.ownerId, s]));

  const items: LibraryBrowserItem[] = libraryTitles.map((t) => {
    const state = stateById.get(t.id);
    const stats = statsById.get(t.id);
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      year: t.year,
      subtitle:
        t.kind === "audiobook"
          ? ((t.authors?.length ? t.authors : [t.folderAuthor]).filter(Boolean).join(", ") || null)
          : null,
      posterUrl: t.posterUrl,
      addedAtMs: t.addedAt.getTime(),
      watched: state?.finished ?? false,
      progressFraction:
        state && !state.finished && state.durationSeconds
          ? state.positionSeconds / state.durationSeconds
          : null,
      processing: !!stats && stats.probed < stats.total,
    };
  });

  const Icon = library.kind === "movies" ? Film : library.kind === "audiobooks" ? Headphones : Tv;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: library.name }]} className="-mb-2" />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Icon className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{library.name}</h1>
          <p className="text-sm text-muted-foreground">
            {library.kind === "movies" ? "Movies" : library.kind === "audiobooks" ? "Audiobooks" : "TV Shows"}
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-24 text-center">
          <p className="text-lg font-medium">Nothing here yet</p>
          <p className="text-sm text-muted-foreground">
            {role === "admin"
              ? "This library hasn't been scanned, or its folder is empty."
              : "Titles will appear once the first scan finishes."}
          </p>
          {role === "admin" && (
            <Button render={<Link href={`/s/${serverId}/admin`} />} className="rounded-xl">
              Go to server settings
            </Button>
          )}
        </div>
      ) : (
        <LibraryBrowser items={items} serverId={serverId} />
      )}
    </div>
  );
}
