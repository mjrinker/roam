import Link from "next/link";
import { and, asc, count, eq, inArray, isNotNull, ne, sum } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AudioLines, Clapperboard, Film, BookOpen, Headphones, Images, Music, Tv } from "lucide-react";
import { db } from "@/lib/db/client";
import { watchedShowIds } from "@/lib/watch/shows";
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
import { isFileTreeLibraryKind, isMusicLibraryKind, isPhotoLibraryKind } from "@/lib/libraries/profile";
import { MusicLibraryView, MusicViewTabs } from "@/components/music/music-library-view";
import { parseSearch } from "@/lib/photos/search";
import { listMonths, listTimeline } from "@/lib/photos/timeline";
import { favoriteWords } from "@/lib/photos/favorite-word";
import { PhotoTimeline } from "@/components/photos/photo-timeline";
import { decodeCursor, encodeCursor } from "@/lib/playlists/http";
import {
  LibraryBrowser,
  type LibraryBrowserItem,
} from "@/components/library/library-browser";

const KIND_ICON = { movies: Film, shows: Tv, audiobooks: Headphones, video: Clapperboard, audio: AudioLines, photos: Images, music: Music, ebooks: BookOpen } as const;
const KIND_LABEL = { movies: "Movies", shows: "TV Shows", audiobooks: "Audiobooks", video: "Videos", audio: "Audio", photos: "Photos", music: "Music", ebooks: "eBooks" } as const;

const folderCursorSchema = z.object({ key: z.string().max(1000).regex(/^[^\u0000]*$/), id: z.string().uuid() });

/** Timeline | Albums, for a photo library. */
function PhotoViewTabs({ serverId, libraryId, active, favoritesLabel }: { serverId: string; libraryId: string; active: "timeline" | "albums" | "favorites"; favoritesLabel: string }) {
  const base = `/s/${serverId}/library/${libraryId}`;
  const tab = (view: "timeline" | "albums" | "favorites", label: string) => (
    <Link
      href={view === "timeline" ? base : `${base}?view=${view}`}
      aria-current={active === view ? "page" : undefined}
      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${active === view ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Photo views" className="flex w-fit gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
      {tab("timeline", "Timeline")}
      {tab("albums", "Albums")}
      {tab("favorites", favoritesLabel)}
    </nav>
  );
}

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

  // A photo library opens to its timeline (newest first, by month), with an Albums tab for its folders.
  const photoView = isPhotoLibraryKind(library.kind) ? (query.view === "albums" ? "albums" : query.view === "favorites" ? "favorites" : "timeline") : null;
  const words = favoriteWords(viewer.locale);
  if (photoView === "timeline" || photoView === "favorites") {
    const search = parseSearch(typeof query.q === "string" ? query.q : null);
    const narrowing = { actor: lib, viewer, viewerId: viewer.id, libraryId, favoritesOnly: photoView === "favorites", search };
    // The newest photos (so the page paints at once) and every month's count (so the whole timeline can be laid out).
    const [page, buckets] = await Promise.all([listTimeline(db, { ...narrowing, limit: 60 }), listMonths(db, { ...narrowing, level: "month" })]);
    if (!page || !buckets) notFound();
    const PhotoIcon = KIND_ICON[library.kind];
    return (
      <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
        <Breadcrumbs serverId={serverId} trail={[{ label: library.name }]} className="-mb-2" />
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
            <PhotoIcon className="size-5 text-primary" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{library.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PhotoViewTabs serverId={serverId} libraryId={libraryId} active={photoView} favoritesLabel={words.plural} />
          <form action={`/s/${serverId}/library/${libraryId}`} method="get" role="search" className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs">
            {photoView === "favorites" && <input type="hidden" name="view" value="favorites" />}
            <input
              type="search"
              name="q"
              defaultValue={search?.text ?? ""}
              maxLength={64}
              placeholder="Search names or dates"
              aria-label="Search this library"
              className="h-9 min-w-0 flex-1 rounded-xl bg-white/[0.06] px-3 text-sm ring-1 ring-white/[0.08] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </form>
        </div>
        <PhotoTimeline
          key={`${photoView}:${search?.text ?? ""}`}
          q={search?.text ?? ""}
          words={{ add: words.add, remove: words.remove }}
          serverId={serverId}
          libraryId={libraryId}
          view={photoView}
          initialItems={page.items}
          initialBuckets={buckets}
          {...(photoView === "favorites" ? { emptyTitle: words.empty, emptyHint: words.emptyHint } : {})}
        />
      </div>
    );
  }

  // A music library opens to its artists (or albums); its Folders tab is the plain folder view below.
  const musicView = isMusicLibraryKind(library.kind) ? (query.view === "albums" ? "albums" : query.view === "folders" ? "folders" : "artists") : null;
  if (musicView === "artists" || musicView === "albums") {
    const after = decodeCursor(typeof query.after === "string" ? query.after : null, folderCursorSchema);
    const view = await MusicLibraryView({ serverId, libraryId, libraryName: library.name, view: musicView, actor: lib, viewer, after: after === "invalid" ? null : after });
    if (!view) notFound();
    return view;
  }

  // A file-tree library (video, audio, and a photo library's albums) is browsed folder by folder (the folder and the page of files come from the URL).
  if (isFileTreeLibraryKind(library.kind)) {
    const path = normalizeFolderPath(typeof query.path === "string" ? query.path : null);
    if (path === null) notFound();
    const after = decodeCursor(typeof query.after === "string" ? query.after : null, folderCursorSchema);
    const page = await listVideoFolder(db, {
      actor: lib,
      viewer,
      viewerId: viewer.id,
      libraryId,
      path,
      limit: 60,
      after: after === "invalid" ? null : after,
    });
    if (!page) notFound();
    const here = `/s/${serverId}/library/${libraryId}?${photoView ? "view=albums&" : ""}${musicView ? "view=folders&" : ""}${path ? `path=${encodeURIComponent(path)}&` : ""}`;
    return (
      <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
        <Breadcrumbs serverId={serverId} trail={[{ label: library.name }]} className="-mb-2" />
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
            {(() => {
              const TreeIcon = KIND_ICON[library.kind];
              return <TreeIcon className="size-5 text-primary" />;
            })()}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{library.name}</h1>
        </div>
        {photoView && <PhotoViewTabs serverId={serverId} libraryId={libraryId} active="albums" favoritesLabel={words.plural} />}
        {musicView && <MusicViewTabs serverId={serverId} libraryId={libraryId} active="folders" />}
        <VideoFolderView
          serverId={serverId}
          libraryId={libraryId}
          libraryName={library.name}
          path={path}
          folders={page.folders}
          items={page.items}
          nextHref={page.nextCursor ? `${here}after=${encodeCursor(page.nextCursor)}` : null}
          itemKind={photoView ? "photo" : library.kind === "audio" || library.kind === "music" ? "audiobook" : library.kind === "ebooks" ? "ebook" : "movie"}
          extraQuery={photoView ? "view=albums" : musicView ? "view=folders" : undefined}
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
  // A show counts as watched when it has episodes and this profile has finished (or marked) every one of them.
  const watchedShows = library.kind === "shows" ? await watchedShowIds(db, viewer.id, libraryTitles.map((t) => t.id)) : new Set<string>();
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
      watched: t.kind === "show" ? watchedShows.has(t.id) : (state?.finished ?? false),
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
