/**
 * Where a title's picture is kept. Image bytes live ONCE in `artwork_images`, keyed by their SHA-256,
 * and each title's `title_artwork` row points at one: every track of an album carries the same cover,
 * and storing it per track would multiply a few hundred kilobytes by thousands of files. An image no
 * title points at any more is removed with the last one that did.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, notExists } from "drizzle-orm";
import { artworkImages, titleArtwork, titles } from "@/lib/db/schema";
import type { Db } from "@/lib/scan/media-files";

/** The URL a title's artwork is served from; `v` changes whenever the image does, so caches never go stale. */
export function artworkUrl(titleId: string, version: Date): string {
  return `/api/titles/${titleId}/artwork?v=${version.getTime()}`;
}

export const imageHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function deleteOrphanImages(ex: Db, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  await ex.delete(artworkImages).where(
    and(
      inArray(artworkImages.hash, hashes),
      notExists(ex.select({ one: titleArtwork.titleId }).from(titleArtwork).where(eq(titleArtwork.imageHash, artworkImages.hash)))
    )
  );
}

/** Saves an image for a title (sharing it with any title that already has the same one) and points its poster at it. */
export async function storeArtwork(
  ex: Db,
  titleId: string,
  image: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array },
  source: "embedded" | "box"
): Promise<void> {
  const now = new Date();
  const bytes = Buffer.from(image.bytes);
  const hash = imageHash(bytes);
  const [previous] = await ex.select({ hash: titleArtwork.imageHash }).from(titleArtwork).where(eq(titleArtwork.titleId, titleId));
  await ex.insert(artworkImages).values({ hash, contentType: image.contentType, bytes }).onConflictDoNothing();
  await ex
    .insert(titleArtwork)
    .values({ titleId, imageHash: hash, source, updatedAt: now })
    .onConflictDoUpdate({ target: titleArtwork.titleId, set: { imageHash: hash, source, updatedAt: now } });
  await ex.update(titles).set({ posterUrl: artworkUrl(titleId, now) }).where(eq(titles.id, titleId));
  if (previous && previous.hash !== hash) await deleteOrphanImages(ex, [previous.hash]);
}

/** Drops these titles' pictures (and any image nothing else uses), leaving `poster_url` for the caller to clear. */
export async function releaseArtwork(ex: Db, titleIds: string[]): Promise<void> {
  if (titleIds.length === 0) return;
  const gone = await ex.delete(titleArtwork).where(inArray(titleArtwork.titleId, titleIds)).returning({ hash: titleArtwork.imageHash });
  await deleteOrphanImages(ex, [...new Set(gone.map((g) => g.hash))]);
}
