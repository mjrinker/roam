import { notFound } from "next/navigation";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import { photoOriginalUrl, photoPreviewUrl } from "@/lib/photos/urls";
import { loadPhoto, photoNeighbors } from "@/lib/photos/timeline";
import { isUuid } from "@/lib/playlists/http";
import { FavoriteButton } from "@/components/photos/favorite-button";
import { favoriteWords } from "@/lib/photos/favorite-word";
import { formatFileSize, formatRuntime } from "@/lib/format";

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
  const isVideo = photo.kind === "movie";
  const rows: [string, string | null][] = [
    ["Taken", photo.takenAt ? taken.format(photo.takenAt) : null],
    ["Size", photo.width && photo.height ? `${photo.width} × ${photo.height}` : null],
    ["Length", isVideo ? formatRuntime(photo.runtimeSeconds) : null],
    ["File", photo.filename],
    ["File size", formatFileSize(photo.sizeBytes)],
    ["Album", photo.folderPath || null],
  ];
  // Browsers show these as they are, so zooming far in may swap to the full-size file (a HEIC can't be shown, so it never is).
  const zoomOriginal = !isVideo && ["jpg", "jpeg", "png", "webp"].includes((photo.container ?? "").toLowerCase());

  return (
    <PhotoViewer
      key={photo.id}
      kind={photo.kind}
      id={photo.id}
      name={photo.name}
      previewUrl={photoPreviewUrl(photo.id)}
      originalUrl={photoOriginalUrl(photo.id)}
      zoomOriginal={zoomOriginal}
      posterUrl={photo.posterUrl}
      details={rows.filter((r): r is [string, string] => r[1] !== null)}
      prevHref={neighbors.prev ? here(neighbors.prev.id) : null}
      nextHref={neighbors.next ? here(neighbors.next.id) : null}
      backHref={backHref}
      // The next item's image is warmed ahead of time (a video's poster; its file is only fetched when played).
      actions={<FavoriteButton id={photo.id} initial={photo.favorite} addLabel={words.add} removeLabel={words.remove} />}
      nextWarmUrl={neighbors.next ? (neighbors.next.kind === "movie" ? neighbors.next.posterUrl : photoPreviewUrl(neighbors.next.id)) : null}
    />
  );
}
