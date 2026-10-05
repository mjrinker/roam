/**
 * Reads each picture's own metadata once: when it was taken (EXIF) and how big it is. Run after
 * probing, in capped batches with a deadline, like the tag pass for video and audio. A date from the
 * picture replaces the one Box gave at scan time (and is then never replaced by a rescan); a picture
 * that carries none keeps Box's. `meta_attempts` caps retries so an unreadable file isn't re-read on
 * every scan, counted up front so a file that takes the function down still counts.
 */
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageProvider } from "@/lib/storage/provider";
import { readImageMeta } from "@/lib/scan/image-meta";

export const MAX_META_ATTEMPTS = 3;
const BATCH = 100;
const CONCURRENCY = 3;

/** Returns true when work remains (batch cap or deadline hit), so the scan stays incomplete and another pass follows. */
export async function readPhotoMetadata(provider: StorageProvider, libraryId: string, deadline: number, errors: string[]): Promise<boolean> {
  const unread = await db
    .select({ titleId: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename, size: mediaFiles.sizeBytes })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(
      and(
        eq(titles.libraryId, libraryId),
        eq(titles.kind, "photo"),
        isNull(titles.metaAttemptedAt),
        lt(titles.metaAttempts, MAX_META_ATTEMPTS),
        isNotNull(mediaFiles.sizeBytes)
      )
    )
    .orderBy(asc(titles.id))
    .limit(BATCH);
  const incomplete = unread.length === BATCH;

  for (let i = 0; i < unread.length; i += CONCURRENCY) {
    if (Date.now() > deadline) return true;
    const settled = await Promise.allSettled(
      unread.slice(i, i + CONCURRENCY).map(async (t) => {
        await db.update(titles).set({ metaAttempts: sql`${titles.metaAttempts} + 1` }).where(eq(titles.id, t.titleId));
        try {
          const meta = await readImageMeta((s, e) => provider.fetchByteRange(t.fileId, s, e), t.size as number);
          const now = new Date();
          await db
            .update(titles)
            .set({
              ...(meta.takenAt ? { takenAt: meta.takenAt, takenAtSource: "exif" as const } : {}),
              width: meta.width,
              height: meta.height,
              metaAttemptedAt: now,
              // Read: whatever failed before no longer counts.
              metaAttempts: 0,
              updatedAt: now,
            })
            .where(and(eq(titles.id, t.titleId), isNull(titles.metaAttemptedAt)));
        } catch (err) {
          if (err instanceof BoxReauthRequiredError) throw err;
          errors.push(`photo ${t.filename}: ${(err as Error).message}`);
        }
      })
    );
    for (const r of settled) if (r.status === "rejected" && r.reason instanceof BoxReauthRequiredError) throw r.reason;
  }
  return incomplete;
}
