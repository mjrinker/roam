/**
 * Descriptive tags and artwork for the titles of a video library, read from the files themselves.
 * Two capped passes, run after probing: (1) once per video whose duration probe succeeded, read its
 * embedded title, year, description and cover; (2) for titles still without a picture, ask Box for
 * its generated thumbnail. Pictures live in `title_artwork` (never read by list queries) and a
 * title's `poster_url` is set ONLY once an image really exists, so a card never shows a broken one.
 * `tag_attempts` caps retries so an unreadable file isn't re-tried on every scan.
 */
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titleArtwork, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageProvider } from "@/lib/storage/provider";
import { probeMp3Tags } from "@/lib/scan/id3-tags";
import { probeMp4Tags } from "@/lib/scan/mp4-duration";
import type { Db } from "@/lib/scan/media-files";
import { VIDEO_PROFILE, type TreeProfile } from "@/lib/scan/tree-profile";

export const MAX_TAG_ATTEMPTS = 3;
export const MAX_THUMB_ATTEMPTS = 3;
/** Box may still be generating a thumbnail; wait this long between asks. */
const THUMB_RETRY_AFTER_MS = 10 * 60 * 1000;
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

interface FileTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  description: string | null;
  cover: { contentType: "image/jpeg" | "image/png"; bytes: Uint8Array } | null;
}

/** An MP3 carries ID3 tags; everything else Roam reads (MP4 video, m4a, m4b) carries MP4 atoms. */
async function readFileTags(
  provider: StorageProvider,
  file: { fileId: string; size: number | null; container: string | null },
  profile: TreeProfile
): Promise<FileTags> {
  const fetchRange = (s: number, e: number) => provider.fetchByteRange(file.fileId, s, e);
  const size = file.size as number;
  if (profile.libraryKind === "audio" && (file.container ?? "").toLowerCase() === "mp3") {
    return { ...(await probeMp3Tags(fetchRange, size)), description: null };
  }
  return probeMp4Tags(fetchRange, size);
}

/**
 * What a read's tags set on the title. Every kind: the embedded title (which a rescan then never
 * overwrites) and year. Video: the description. Audio: the artist as the author (explicitly null when
 * the file names none, so a replaced file can't keep a stale one), the description, and the album as the
 * series, but only when it isn't just the title again (an m4b's album usually is).
 */
function titleColumns(tags: FileTags, profile: TreeProfile, currentName: string) {
  const base = {
    ...(tags.title ? { name: tags.title, nameSource: "embedded" as const } : {}),
    ...(tags.year ? { year: tags.year } : {}),
    ...(tags.description ? { overview: tags.description } : {}),
  };
  if (profile.libraryKind !== "audio") return base;
  const effectiveTitle = (tags.title ?? currentName).trim().toLowerCase();
  const album = tags.album && tags.album.trim().toLowerCase() !== effectiveTitle ? tags.album : null;
  return { ...base, authors: tags.artist ? [tags.artist] : null, seriesName: album };
}

/** Returns true when work remains (batch cap or deadline hit), so the scan stays incomplete and another pass follows. */
export async function readTagsAndArtwork(
  provider: StorageProvider,
  libraryId: string,
  deadline: number,
  errors: string[],
  profile: TreeProfile = VIDEO_PROFILE
): Promise<boolean> {
  // 1. Tags: videos whose duration probe succeeded and whose tags haven't been read.
  const untagged = await db
    .select({
      titleId: titles.id,
      currentName: titles.name,
      fileId: mediaFiles.boxFileId,
      filename: mediaFiles.filename,
      container: mediaFiles.container,
      size: mediaFiles.sizeBytes,
    })
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
      // Counted up front: if reading this file takes the whole function down, it still counts, so one
      // poisoned file can never stall every future scan.
      await db.update(titles).set({ tagAttempts: sql`${titles.tagAttempts} + 1` }).where(eq(titles.id, t.titleId));
      try {
        const tags = await readFileTags(provider, t, profile);
        await db.transaction(async (tx) => {
          const now = new Date();
          await tx
            .update(titles)
            .set({
              ...titleColumns(tags, profile, t.currentName),
              tagsAttemptedAt: now,
              // The attempt counted up front succeeded, so it doesn't count against the thumbnail tries.
              tagAttempts: sql`greatest(${titles.tagAttempts} - 1, 0)`,
              updatedAt: now,
            })
            .where(and(eq(titles.id, t.titleId), isNull(titles.tagsAttemptedAt)));
          if (tags.cover) await storeArtwork(tx, t.titleId, tags.cover, "embedded");
        });
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        errors.push(`tags ${t.filename}: ${(err as Error).message}`);
      }
    })) || incomplete;

  // 2. Pictures: titles that still have none (no embedded cover): Box's own thumbnail. Independent of the
  // tag read (a file whose tags can't be read can still have a thumbnail), with its own attempt count and
  // a pause between asks, since Box answers "not ready yet" for a while after a file appears.
  if (!profile.thumbnails || !provider.fetchThumbnail) return incomplete;
  const fetchThumbnail = provider.fetchThumbnail.bind(provider);
  const retryBefore = new Date(Date.now() - THUMB_RETRY_AFTER_MS);
  const pictureless = await db
    .select({ titleId: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(
      and(
        eq(titles.libraryId, libraryId),
        isNull(titles.posterUrl),
        lt(titles.thumbAttempts, MAX_THUMB_ATTEMPTS),
        or(isNull(titles.thumbAttemptedAt), lt(titles.thumbAttemptedAt, retryBefore)),
        eq(mediaFiles.probeStatus, "ok"),
        isNotNull(mediaFiles.sizeBytes)
      )
    )
    .orderBy(asc(titles.id))
    .limit(BATCH);
  if (pictureless.length === BATCH) incomplete = true;

  return (
    (await inBatches(pictureless, deadline, async (t) => {
      // Counted and time-stamped up front, like tag reads: a failure that kills the function still counts.
      await db
        .update(titles)
        .set({ thumbAttempts: sql`${titles.thumbAttempts} + 1`, thumbAttemptedAt: new Date() })
        .where(eq(titles.id, t.titleId));
      try {
        const thumb = await fetchThumbnail(t.fileId);
        if (thumb) await storeArtwork(db, t.titleId, thumb, "box");
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        errors.push(`thumbnail ${t.filename}: ${(err as Error).message}`);
      }
    })) || incomplete
  );
}
