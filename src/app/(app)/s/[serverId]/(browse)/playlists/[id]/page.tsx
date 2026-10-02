import { notFound } from "next/navigation";
import { Globe, Lock } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { encodeCursor } from "@/lib/playlists/http";
import { listItems } from "@/lib/playlists/item-service";
import { nextAfter } from "@/lib/playlists/next";
import { getPlaylistDetail } from "@/lib/playlists/service";
import { Badge } from "@/components/ui/badge";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PlaylistActions } from "@/components/playlists/playlist-actions";
import { PlaylistItems } from "@/components/playlists/playlist-items";
import { isUuid } from "@/lib/playlists/http";

export default async function PlaylistPage({ params }: PageProps<"/s/[serverId]/playlists/[id]">) {
  const { serverId, id } = await params;
  const { viewer } = await requireServerMember(serverId);
  if (!isUuid(id)) notFound();

  const detail = await getPlaylistDetail(db, { playlistId: id, viewerId: viewer.id });
  // A playlist from a different server 404s here, like one that doesn't exist.
  if (!detail.ok || detail.value.serverId !== serverId) notFound();
  const playlist = detail.value;

  const [firstPage, start] = await Promise.all([
    listItems(db, { playlistId: id, viewerId: viewer.id, limit: 50 }),
    nextAfter(db, { playlistId: id, viewerId: viewer.id }),
  ]);
  if (!firstPage.ok) notFound();
  const playHref = start.ok && start.value ? start.value.href : null;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs
        serverId={serverId}
        trail={[{ label: "Playlists", href: `/s/${serverId}/playlists` }, { label: playlist.name }]}
        className="-mb-2"
      />

      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{playlist.name}</h1>
        {playlist.description && <p className="max-w-3xl text-muted-foreground">{playlist.description}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
          <span>
            {playlist.itemCount} item{playlist.itemCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span>
            {playlist.owner ? (playlist.myRole === "owner" ? "Yours" : `By ${playlist.owner.name}`) : "No owner — view only"}
          </span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5">
            {playlist.visibility === "server" ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />}
            {playlist.visibility === "server" ? "Everyone on this server" : "Private"}
          </span>
          {playlist.myRole !== "owner" && (
            <Badge variant="secondary" className="capitalize">
              {playlist.myRole}
            </Badge>
          )}
        </div>
      </header>

      <PlaylistActions
        serverId={serverId}
        playlistId={playlist.id}
        name={playlist.name}
        playHref={playHref}
        can={{ rename: playlist.can.rename, delete: playlist.can.delete, leave: playlist.can.leave, copy: playlist.can.copy }}
      />

      <PlaylistItems
        serverId={serverId}
        playlistId={playlist.id}
        initialItems={firstPage.value.items}
        initialCursor={firstPage.value.nextCursor ? encodeCursor(firstPage.value.nextCursor) : null}
        canEdit={playlist.can.editItems}
      />
    </div>
  );
}
