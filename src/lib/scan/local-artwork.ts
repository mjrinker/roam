/**
 * Posters kept beside movies and shows (support.plex.tv "Local Media Assets"): in the movie's folder "cover", "default", "folder", "movie" or
 * "poster"; for a show, in the show's folder "folder", "poster" or "show"; for a movie not in a folder, a picture named like the movie
 * ("Avatar (2009).jpg"). jpg, jpeg, png and tbn. A poster found replaces the one TMDB gave, and stays through rescans until the file goes.
 * (Background art, logos, banners and per-season pictures are not used: Roam draws those from TMDB.)
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titleArtwork, titles } from "@/lib/db/schema";
import { artworkUrl, storeArtwork } from "@/lib/scan/artwork-store";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import { extOf } from "@/lib/scan/poster-names";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";

const MAX_POSTER_BYTES = 8 * 1024 * 1024;

export { MOVIE_POSTER_NAMES, SHOW_POSTER_NAMES, posterFile } from "@/lib/scan/poster-names";

/** Makes the title's poster the picture file (read again only when the file is newer), or leaves TMDB's when there is none. Never fails a scan. */
export async function syncLocalPoster(provider: Pick<StorageProvider, "fetchByteRange">, titleId: string, poster: StorageEntry | null): Promise<void> {
  if (!poster) return;
  try {
    const [art] = await db.select({ source: titleArtwork.source, updatedAt: titleArtwork.updatedAt }).from(titleArtwork).where(eq(titleArtwork.titleId, titleId)).limit(1);
    if (art?.source === "box" && poster.modifiedAt && art.updatedAt >= poster.modifiedAt) {
      // Already this picture: only make sure a metadata match hasn't pointed the poster back at TMDB.
      await db.update(titles).set({ posterUrl: artworkUrl(titleId, art.updatedAt) }).where(and(eq(titles.id, titleId)));
      return;
    }
    const size = poster.sizeBytes ?? MAX_POSTER_BYTES;
    if (size <= 0 || size > MAX_POSTER_BYTES) return;
    const bytes = new Uint8Array(await provider.fetchByteRange(poster.id, 0, size - 1));
    await storeArtwork(db, titleId, { contentType: extOf(poster.name) === "png" ? "image/png" : "image/jpeg", bytes }, "box");
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) throw err;
    console.error(`poster file for ${titleId}:`, err);
  }
}
