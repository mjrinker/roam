import { notFound } from "next/navigation";
import { UserRound } from "lucide-react";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/playlists/http";
import { artistSongIds, getArtist } from "@/lib/music/browse";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { AlbumTile, TILE_GRID } from "@/components/music/music-cards";
import { AddSongsToPlaylistMenu } from "@/components/playlists/add-songs-to-playlist-menu";
import { AlbumPlayButtons } from "@/components/music/track-list";

export default async function ArtistPage({ params }: PageProps<"/s/[serverId]/artist/[id]">) {
  const { serverId, id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, viewer, role } = await requireServerMember(serverId);
  const found = await getArtist(db, { actor: libraryActor({ profile, role }, serverId), viewer, artistId: id });
  if (!found) notFound();
  const { artist, albums } = found;
  // All of the artist's songs (albums oldest first), for Play and Shuffle.
  const songIds = (await artistSongIds(db, { actor: libraryActor({ profile, role }, serverId), viewer, artistId: id }, 2000)) ?? [];

  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: artist.libraryName, href: `/s/${serverId}/library/${artist.libraryId}` }, { label: artist.name }]} />
      <div className="flex items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
          <UserRound className="size-6 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{artist.name}</h1>
          <p className="text-sm text-muted-foreground">
            {albums.length} {albums.length === 1 ? "album" : "albums"}
          </p>
        </div>
        <div className="ml-auto">
          <AddSongsToPlaylistMenu serverId={serverId} target={{ artistId: artist.id }} label="Add all songs to playlist" />
        </div>
      </div>
      <AlbumPlayButtons ids={songIds} />
      <div className={TILE_GRID}>
        {albums.map((a) => (
          <AlbumTile key={a.id} serverId={serverId} album={a} showArtist={false} />
        ))}
      </div>
    </div>
  );
}
