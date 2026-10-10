import Link from "next/link";
import { SongViewTabs } from "@/components/library/audio-views";
import { ChooseButton } from "@/components/choose/choose-entry";
import { Music } from "lucide-react";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { listAlbums, listArtists, type Cursor } from "@/lib/music/browse";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { SelectableMusicTiles } from "@/components/library/selectable-views";
import { encodeCursor } from "@/lib/playlists/http";

/** A music library's Artists or Albums tab: one page of tiles, with a link to the next. */
export async function MusicLibraryView({
  serverId,
  libraryId,
  libraryName,
  view,
  actor,
  viewer,
  after,
}: {
  serverId: string;
  libraryId: string;
  libraryName: string;
  view: "artists" | "albums";
  actor: LibraryActor;
  viewer: AccessProfile;
  after: Cursor | null;
}) {
  const scope = { actor, viewer, libraryId, after };
  const [artists, albums] = view === "artists" ? [await listArtists(db, scope), null] : [null, await listAlbums(db, scope)];
  const page = artists ?? albums;
  if (!page) return null;
  const nextHref = page.next ? `/s/${serverId}/library/${libraryId}?${view === "albums" ? "view=albums&" : ""}after=${encodeCursor(page.next)}` : null;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: libraryName }]} className="-mb-2" />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Music className="size-5 text-primary" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{libraryName}</h1>
        <ChooseButton serverId={serverId} libraryId={libraryId} className="ml-auto" />
      </div>
      <SongViewTabs serverId={serverId} libraryId={libraryId} kind="music" active={view} />
      {page.items.length === 0 ? (
        <p className="rounded-xl bg-white/[0.04] px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">
          Nothing here yet. Songs show up once a scan has read the library&apos;s folders.
        </p>
      ) : (
        <SelectableMusicTiles serverId={serverId} libraryId={libraryId} view={view} albums={albums?.items ?? null} artists={artists?.items ?? null} />
      )}
      {nextHref && (
        <Link href={nextHref} className="w-fit rounded-xl bg-white/[0.08] px-5 py-2.5 text-sm font-medium hover:bg-white/[0.14]">
          Show more
        </Link>
      )}
    </div>
  );
}
