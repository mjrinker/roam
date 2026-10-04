import Link from "next/link";
import { and, asc, count, eq, inArray, isNotNull, ne, sum } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AudioLines, Clapperboard, Film, Headphones, Tv } from "lucide-react";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles, watchState } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { contentFilter, effectiveAge } from "@/lib/content/access";
import { countryFromLocale, displayCertification } from "@/lib/content/ratings";
import { needsAudioFix } from "@/lib/scan/codec-support";
import { Button } from "@/components/ui/button";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { VideoFolderView } from "@/components/library/video-folder-view";
import { listFolder as listVideoFolder, normalizeFolderPath } from "@/lib/libraries/folder-browse";
import { decodeCursor, encodeCursor } from "@/lib/playlists/http";
import {
  LibraryBrowser,
  type LibraryBrowserItem,
} from "@/components/library/library-browser";

const KIND_ICON = { movies: Film, shows: Tv, audiobooks: Headphones, video: Clapperboard, audio: AudioLines } as const;
const KIND_LABEL = { movies: "Movies", shows: "TV Shows", audiobooks: "Audiobooks", video: "Videos", audio: "Audio" } as const;

const folderCursorSchema = z.object({ name: z.string().max(500).regex(/^[^\u0000]*$/), id: z.string().uuid() });

export default async function LibraryDetailPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/library/[libraryId]">) {
  const { serverId, libraryId } = await params;
  const query = await searchParams;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);

  // Confirm the library actually belongs to this server before showing
  // anything — don't trust the bare id from the URL.
  const [library] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), libraryVisible(db, lib)))
    .limit(1);
  if (!library) notFound();

  // A video library is browsed folder by folder (the folder and the page of videos come from the URL).
  if (library.kind === "video") {
    const path = normalizeFolderPath(typeof query.path === "string" ? query.path : null);
    if (path === null) notFound();
    const after = decodeCursor(typeof query.after === "string" ? query.after : null, folderCursorSchema);
    const page = await listVideoFolder(db, {
      actor: lib,
      viewer,
      libraryId,
      path,
      limit: 60,
      after: after === "invalid" ? null : after,
    });
    if (!page) notFound();
    const here = `/s/${serverId}/library/${libraryId}?${path ? `path=${encodeURIComponent(path)}&` : ""}`;
    return (
      <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
        <Breadcrumbs serverId={serverId} trail={[{ label: library.name }]} className="-mb-2" />
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
            <Clapperboard className="size-5 text-primary" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{library.name}</h1>
        </div>
        <VideoFolderView
          serverId={serverId}
          libraryId={libraryId}
          libraryName={library.name}
          path={path}
          folders={page.folders}
          items={page.items}
          nextHref={page.nextCursor ? `${here}after=${encodeCursor(page.nextCursor)}` : null}
        />
      </div>
    );
  }

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
            seconds: sum(mediaFiles.durationSeconds),
          })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, movieIds)))
          .groupBy(mediaFiles.ownerId),
      ])
    : [[], []];
  const stateById = new Map(states.map((s) => [s.ownerId, s]));
  const statsById = new Map(fileStats.map((s) => [s.ownerId, s]));

  // Admin-only "audio needs fixing" flag per title: a movie/audiobook's own
  // files, or any episode's files for a show. Only rows with a non-AAC codec
  // can qualify, so fetch just those and let needsAudioFix make the call.
  const audioFixIds = new Set<string>();
  if (role === "admin" && libraryTitles.length > 0) {
    const notAac = and(isNotNull(mediaFiles.audioCodec), ne(mediaFiles.audioCodec, "mp4a"));
    const rows =
      library.kind === "shows"
        ? await db
            .select({
              titleId: seasons.titleId,
              audioCodec: mediaFiles.audioCodec,
              remuxStatus: mediaFiles.remuxStatus,
            })
            .from(mediaFiles)
            .innerJoin(episodes, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
            .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
            .innerJoin(titles, eq(seasons.titleId, titles.id))
            .where(and(eq(titles.libraryId, libraryId), notAac))
        : await db
            .select({
              titleId: mediaFiles.ownerId,
              audioCodec: mediaFiles.audioCodec,
              remuxStatus: mediaFiles.remuxStatus,
            })
            .from(mediaFiles)
            .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, movieIds), notAac));
    const byTitle = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.titleId) byTitle.set(r.titleId, [...(byTitle.get(r.titleId) ?? []), r]);
    }
    for (const [titleId, titleRows] of byTitle) if (needsAudioFix(titleRows)) audioFixIds.add(titleId);
  }
  const country = countryFromLocale(viewer.locale);

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
      genres: t.genres ?? [],
      runtimeSeconds: t.runtimeSeconds ?? (stats?.seconds ? Number(stats.seconds) : null),
      certification: displayCertification(t.certifications, country),
      ratingAge: effectiveAge(t.ratingAges, country),
      imdbRating: t.imdbRating,
      rottenTomatoesScore: t.rottenTomatoesScore,
      needsAudioFix: audioFixIds.has(t.id),
      watched: state?.finished ?? false,
      progressFraction:
        state && !state.finished && state.durationSeconds
          ? state.positionSeconds / state.durationSeconds
          : null,
      processing: !!stats && stats.probed < stats.total,
    };
  });

  const Icon = KIND_ICON[library.kind];

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
            {KIND_LABEL[library.kind]}
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
        <LibraryBrowser items={items} serverId={serverId} isAdmin={role === "admin"} />
      )}
    </div>
  );
}
