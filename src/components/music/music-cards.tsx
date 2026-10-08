import Link from "next/link";
import { Disc3, UserRound } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import type { AlbumCard, ArtistCard } from "@/lib/music/browse";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Cover({ url, alt, round, sizes }: { url: string | null; alt: string; round?: boolean; sizes: string }) {
  return (
    <div className={`relative aspect-square overflow-hidden bg-muted ring-1 ring-white/[0.08] transition duration-300 group-hover/card:-translate-y-1 group-hover/card:ring-white/25 ${round ? "rounded-full" : "rounded-xl"}`}>
      {url ? (
        <Image src={url} alt={alt} fill sizes={sizes} className="object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-background">
          {round ? <UserRound className="size-1/3 text-muted-foreground/60" /> : <Disc3 className="size-1/3 text-muted-foreground/60" />}
        </div>
      )}
    </div>
  );
}

export function AlbumTile({ serverId, album, showArtist = true }: { serverId: string; album: AlbumCard; showArtist?: boolean }) {
  return (
    <Link href={`/s/${serverId}/album/${album.id}`} className="group/card flex min-w-0 flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl">
      <Cover url={album.coverUrl} alt={`${album.name} cover`} sizes="(min-width: 1024px) 200px, 45vw" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{album.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[showArtist ? album.artistName : null, album.year, plural(album.trackCount, "song")].filter(Boolean).join(" · ")}
        </p>
      </div>
    </Link>
  );
}

export function ArtistTile({ serverId, artist }: { serverId: string; artist: ArtistCard }) {
  return (
    <Link href={`/s/${serverId}/artist/${artist.id}`} className="group/card flex min-w-0 flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl">
      <Cover url={artist.coverUrls[0] ?? null} alt={`${artist.name}`} round sizes="(min-width: 1024px) 200px, 45vw" />
      <div className="min-w-0 text-center">
        <p className="truncate text-sm font-medium">{artist.name}</p>
        <p className="truncate text-xs text-muted-foreground">{plural(artist.albumCount, "album")}</p>
      </div>
    </Link>
  );
}

export const TILE_GRID = "grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
