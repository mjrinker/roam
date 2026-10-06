import { notFound } from "next/navigation";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { PhotoPageViewer } from "@/components/photos/photo-page-viewer";
import { viewerItem } from "@/lib/photos/viewer-item";
import { loadPhoto, photoNeighbors } from "@/lib/photos/timeline";
import { isUuid } from "@/lib/playlists/http";
import { favoriteWords } from "@/lib/photos/favorite-word";

// The page links to a download URL that is a credential for a short while; never send it on as a referrer.
export const metadata = { referrer: "no-referrer" as const };


export default async function PhotoPage({ params, searchParams }: PageProps<"/s/[serverId]/photo/[id]">) {
  const { serverId, id } = await params;
  const query = await searchParams;
  const { profile, viewer, role } = await requireServerMember(serverId);
  if (!isUuid(id)) notFound();
  const actor = libraryActor({ profile, role }, serverId);

  // The photo must be a picture in a photo library this account may see, within the age limit, on THIS
  // server (the actor binds the server), or it is simply not found.
  const photo = await loadPhoto(db, { actor, viewer, viewerId: viewer.id, id });
  if (!photo) notFound();

  // Where you came from decides what "next" means: the timeline, or this photo's own album.
  const fromAlbum = query.from === "album";
  const fromFavorites = query.from === "favorites";
  const neighbors = await photoNeighbors(db, {
    actor,
    viewer,
    photo,
    scope: fromAlbum ? { kind: "folder", path: photo.folderPath } : fromFavorites ? { kind: "favorites", viewerId: viewer.id } : { kind: "timeline" },
  });
  const from = fromAlbum ? `from=album&path=${encodeURIComponent(photo.folderPath)}` : fromFavorites ? "from=favorites" : "from=timeline";
  const here = (photoId: string) => `/s/${serverId}/photo/${photoId}?${from}`;
  const library = `/s/${serverId}/library/${photo.libraryId}`;
  const backHref = fromFavorites ? `${library}?view=favorites` : fromAlbum ? `${library}?view=albums${photo.folderPath ? `&path=${encodeURIComponent(photo.folderPath)}` : ""}` : library;

  const words = favoriteWords(viewer.locale);
  const asItem = (x: typeof photo) => viewerItem({ ...x, takenAt: x.takenAt });
  // A neighbour only needs its thumbnail beside the current item.
  const neighbor = (n: { id: string; kind: "photo" | "movie"; posterUrl: string | null } | null) =>
    n && viewerItem({ id: n.id, kind: n.kind, name: "", takenAt: null, width: null, height: null, posterUrl: n.posterUrl, runtimeSeconds: null, favorite: false, filename: null, sizeBytes: null, container: null, folderPath: "" });

  return (
    <PhotoPageViewer
      key={photo.id}
      current={asItem(photo)}
      prev={neighbor(neighbors.prev)}
      next={neighbor(neighbors.next)}
      prevHref={neighbors.prev ? here(neighbors.prev.id) : null}
      nextHref={neighbors.next ? here(neighbors.next.id) : null}
      backHref={backHref}
      libraryId={photo.libraryId}
      words={{ add: words.add, remove: words.remove }}
    />
  );
}
