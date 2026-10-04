/**
 * Descriptive tags and artwork for the titles of a video library, read from the files themselves.
 * Two capped passes, run after probing: (1) once per video whose duration probe succeeded, read its
 * embedded title, year, description and cover; (2) for titles still without a picture, ask Box for
 * its generated thumbnail. Pictures live in `title_artwork` (never read by list queries) and a
 * title's `poster_url` is set ONLY once an image really exists, so a card never shows a broken one.
 * `tag_attempts` caps retries so an unreadable file isn't re-tried on every scan.
 */
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titleArtwork, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageProvider } from "@/lib/storage/provider";
import { probeMp4Tags } from "@/lib/scan/mp4-duration";
import type { Db } from "@/lib/scan/media-files";

export const MAX_TAG_ATTEMPTS = 3;
const BATCH = 100;
const CONCURRENCY = 3;

/** The URL a title's artwork is served from; `v` changes whenever the image does, so caches never go stale. */
export function artworkUrl(titleId: string, version: Date): string {
  return `/api/titles/${titleId}/artwork?v=${version.getTime()}`;
}

/** Saves an image for a title and points its poster at it. */
export async function storeArtwork(
  ex: Db,
  titleId: string,
  image: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array },
  source: "embedded" | "box"
): Promise<void> {
  const now = new Date();
  const bytes = Buffer.from(image.bytes);
  await ex
    .insert(titleArtwork)
    .values({ titleId, contentType: image.contentType, bytes, source, updatedAt: now })
    .onConflictDoUpdate({ target: titleArtwork.titleId, set: { contentType: image.contentType, bytes, source, updatedAt: now } });
  await ex.update(titles).set({ posterUrl: artworkUrl(titleId, now) }).where(eq(titles.id, titleId));
}

async function inBatches<T>(items: T[], deadline: number, fn: (item: T) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (Date.now() > deadline) return true;
    const results = await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(fn));
    for (const r of results) {
      if (r.status === "rejected" && r.reason instanceof BoxReauthRequiredError) throw r.reason;
    }
  }
  return false;
}

/** Returns true when work remains (batch cap or deadline hit), so the scan stays incomplete and another pass follows. */
export async function readTagsAndArtwork(
  provider: StorageProvider,
  libraryId: string,
  deadline: number,
  errors: string[]
): Promise<boolean> {
  // 1. Tags: videos whose duration probe succeeded and whose tags haven't been read.
  const untagged = await db
    .select({ titleId: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename, size: mediaFiles.sizeBytes })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(
      and(
        eq(titles.libraryId, libraryId),
        isNull(titles.tagsAttemptedAt),
        lt(titles.tagAttempts, MAX_TAG_ATTEMPTS),
        eq(mediaFiles.probeStatus, "ok"),
        isNotNull(mediaFiles.sizeBytes)
      )
    )
    .orderBy(asc(titles.id))
    .limit(BATCH);
  let incomplete = untagged.length === BATCH;

  incomplete =
    (await inBatches(untagged, deadline, async (t) => {
      try {
        const tags = await probeMp4Tags((s, e) => provider.fetchByteRange(t.fileId, s, e), t.size as number);
        await db.transaction(async (tx) => {
          const now = new Date();
          await tx
            .update(titles)
            .set({
              ...(tags.title ? { name: tags.title, nameSource: "embedded" as const } : {}),
              ...(tags.year ? { year: tags.year } : {}),
              ...(tags.description ? { overview: tags.description } : {}),
              tagsAttemptedAt: now,
              updatedAt: now,
            })
            .where(and(eq(titles.id, t.titleId), isNull(titles.tagsAttemptedAt)));
          if (tags.cover) await storeArtwork(tx, t.titleId, tags.cover, "embedded");
        });
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        errors.push(`tags ${t.filename}: ${(err as Error).message}`);
        await db.update(titles).set({ tagAttempts: sql`${titles.tagAttempts} + 1` }).where(eq(titles.id, t.titleId));
      }
    })) || incomplete;

  // 2. Pictures: titles whose tags were read but that still have none (no embedded cover): Box's own thumbnail.
  if (!provider.fetchThumbnail) return incomplete;
  const fetchThumbnail = provider.fetchThumbnail.bind(provider);
  const pictureless = await db
    .select({ titleId: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(and(eq(titles.libraryId, libraryId), isNull(titles.posterUrl), isNotNull(titles.tagsAttemptedAt), lt(titles.tagAttempts, MAX_TAG_ATTEMPTS)))
    .orderBy(asc(titles.id))
    .limit(BATCH);
  if (pictureless.length === BATCH) incomplete = true;

  return (
    (await inBatches(pictureless, deadline, async (t) => {
      try {
        const thumb = await fetchThumbnail(t.fileId);
        if (thumb) await storeArtwork(db, t.titleId, thumb, "box");
        else await db.update(titles).set({ tagAttempts: sql`${titles.tagAttempts} + 1` }).where(eq(titles.id, t.titleId));
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        errors.push(`thumbnail ${t.filename}: ${(err as Error).message}`);
        await db.update(titles).set({ tagAttempts: sql`${titles.tagAttempts} + 1` }).where(eq(titles.id, t.titleId));
      }
    })) || incomplete
  );
}
