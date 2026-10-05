import { notFound } from "next/navigation";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import { photoOriginalUrl, photoPreviewUrl } from "@/lib/photos/urls";
import { loadPhoto, photoNeighbors } from "@/lib/photos/timeline";
import { isUuid } from "@/lib/playlists/http";

// The page links to a download URL that is a credential for a short while; never send it on as a referrer.
export const metadata = { referrer: "no-referrer" as const };

const taken = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });

export default async function PhotoPage({ params, searchParams }: PageProps<"/s/[serverId]/photo/[id]">) {
  const { serverId, id } = await params;
  const query = await searchParams;
  const { profile, viewer, role } = await requireServerMember(serverId);
  if (!isUuid(id)) notFound();
  const actor = libraryActor({ profile, role }, serverId);

  // The photo must be a picture in a photo library this account may see, within the age limit, on THIS
  // server (the actor binds the server), or it is simply not found.
  const photo = await loadPhoto(db, { actor, viewer, id });
  if (!photo) notFound();

  // Where you came from decides what "next" means: the timeline, or this photo's own album.
  const fromAlbum = query.from === "album";
  const neighbors = await photoNeighbors(db, { actor, viewer, photo, scope: fromAlbum ? { kind: "folder", path: photo.folderPath } : { kind: "timeline" } });
  const from = fromAlbum ? `from=album&path=${encodeURIComponent(photo.folderPath)}` : "from=timeline";
  const here = (photoId: string) => `/s/${serverId}/photo/${photoId}?${from}`;
  const library = `/s/${serverId}/library/${photo.libraryId}`;
  const backHref = fromAlbum ? `${library}?view=albums${photo.folderPath ? `&path=${encodeURIComponent(photo.folderPath)}` : ""}` : library;

  return (
    <PhotoViewer
      previewUrl={photoPreviewUrl(photo.id)}
      originalUrl={photoOriginalUrl(photo.id)}
      name={photo.name}
      takenLabel={photo.takenAt ? taken.format(photo.takenAt) : null}
      dimensions={photo.width && photo.height ? `${photo.width} × ${photo.height}` : null}
      prevHref={neighbors.prev ? here(neighbors.prev) : null}
      nextHref={neighbors.next ? here(neighbors.next) : null}
      backHref={backHref}
      nextPreviewUrl={neighbors.next ? photoPreviewUrl(neighbors.next) : null}
    />
  );
}
