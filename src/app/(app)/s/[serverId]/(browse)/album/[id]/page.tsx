import { notFound } from "next/navigation";
import Link from "next/link";
import { Disc3 } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { formatRuntime } from "@/lib/format";
import { isUuid } from "@/lib/playlists/http";
import { getAlbum } from "@/lib/music/browse";
import { and, eq, inArray } from "drizzle-orm";
import { watchState } from "@/lib/db/schema";
import { AddSongsToPlaylistMenu } from "@/components/playlists/add-songs-to-playlist-menu";
import { MarkDoneButton } from "@/components/library/mark-done-button";
import { MoreMenu } from "@/components/shell/more-menu";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { AlbumPlayButtons, TrackList } from "@/components/music/track-list";
import { AlbumRematchButton } from "@/components/admin/album-rematch-button";

export default async function AlbumPage({ params }: PageProps<"/s/[serverId]/album/[id]">) {
  const { serverId, id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, viewer, role } = await requireServerMember(serverId);
  const page = await getAlbum(db, { actor: libraryActor({ profile, role }, serverId), viewer, albumId: id });
  if (!page) notFound();
  const { album, tracks: plain, totalSeconds } = page;
  // Which songs this profile has marked as listened to (marking an album marks each of its songs).
  const finished = plain.length
    ? await db.select({ id: watchState.ownerId }).from(watchState).where(and(eq(watchState.viewerId, viewer.id), eq(watchState.ownerKind, "title"), eq(watchState.finished, true), inArray(watchState.ownerId, plain.map((t) => t.id))))
    : [];
  const doneIds = new Set(finished.map((f) => f.id));
  const tracks = plain.map((t) => ({ ...t, done: doneIds.has(t.id) }));
  const albumDone = tracks.length > 0 && tracks.every((t) => t.done);
  const runtime = formatRuntime(totalSeconds);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs
        serverId={serverId}
        trail={[
          { label: album.libraryName, href: `/s/${serverId}/library/${album.libraryId}` },
          { label: album.artistName, href: `/s/${serverId}/artist/${album.artistId}` },
          { label: album.name },
        ]}
      />
      <header className="flex flex-col items-center gap-6 sm:flex-row sm:items-end">
        <div className="relative aspect-square w-52 shrink-0 overflow-hidden rounded-2xl bg-muted shadow-[0_30px_70px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10 sm:w-60">
          {album.coverUrl ? (
            <Image src={album.coverUrl} alt={`${album.name} cover`} fill sizes="240px" className="object-cover" priority />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-background">
              <Disc3 className="size-16 text-muted-foreground/60" />
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col items-center gap-3 text-center sm:items-start sm:text-left">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Album</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{album.name}</h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/s/${serverId}/artist/${album.artistId}`} className="font-medium text-foreground hover:text-primary">
              {album.artistName}
            </Link>
            {[album.year, `${album.trackCount} ${album.trackCount === 1 ? "song" : "songs"}`, runtime].filter(Boolean).map((part) => ` · ${part}`)}
          </p>
          <AlbumPlayButtons ids={tracks.map((t) => t.id)}>
            <MoreMenu>
              <AddSongsToPlaylistMenu serverId={serverId} target={{ albumId: album.id }} label="Add album to playlist" />
              <MarkDoneButton kind="album" id={album.id} done={albumDone} media="listen" scope="album" />
              {role === "admin" && viewer.role !== "limited" && <AlbumRematchButton albumId={album.id} matched={album.matched} />}
            </MoreMenu>
          </AlbumPlayButtons>
        </div>
      </header>
      <TrackList tracks={tracks} serverId={serverId} />
    </div>
  );
}
