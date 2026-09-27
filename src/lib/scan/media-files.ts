import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  AUDIO_MP4_CONTAINERS,
  containerOf,
  estimateAudioDurationMs,
} from "@/lib/scan/containers";
import { probeMp3 } from "@/lib/scan/mp3-duration";
import { probeMp4, type Mp4Chapter } from "@/lib/scan/mp4-duration";

type MediaFileRow = typeof mediaFiles.$inferSelect;

// ── Segments ─────────────────────────────────────────────────────────────

/**
 * Makes an owner's media_files match `files` (already in playback order):
 * removes rows for files that are gone, then upserts the rest with their new
 * part index. Runs in one transaction.
 */
export async function upsertMediaSegments(
  ownerKind: "title" | "episode",
  ownerId: string,
  files: StorageEntry[]
) {
  if (files.length === 0) return;
  const currentIds = files.map((f) => f.id);

  // (owner_kind, owner_id, part_index) is unique, so stale rows (removed,
  // renamed, or now-excluded extras like trailers) must go before the
  // upserts: a surviving file moving into a stale row's part_index would
  // otherwise violate the index. Surviving rows are also parked at negative
  // indexes first so files that swap or shift positions can't collide with
  // each other mid-update.
  await db.transaction(async (tx) => {
    const owned = and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId));

    await tx.delete(mediaFiles).where(and(owned, notInArray(mediaFiles.boxFileId, currentIds)));
    await tx
      .update(mediaFiles)
      .set({ partIndex: sql`-${mediaFiles.partIndex} - 1` })
      .where(and(owned, inArray(mediaFiles.boxFileId, currentIds)));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await tx
        .insert(mediaFiles)
        .values({
          ownerKind,
          ownerId,
          partIndex: i,
          boxFileId: file.id,
          filename: file.name,
          sizeBytes: file.sizeBytes,
          container: file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase(),
        })
        .onConflictDoUpdate({
          target: mediaFiles.boxFileId,
          set: { partIndex: i, filename: file.name, sizeBytes: file.sizeBytes },
        });
    }
  });
}

// ── Probing ──────────────────────────────────────────────────────────────

/** After this many failed tries a part is given up on (see estimateAudioDurationMs). */
export const MAX_PROBE_ATTEMPTS = 3;
const PROBE_CONCURRENCY = 3;

async function probeOne(
  provider: StorageProvider,
  file: MediaFileRow
): Promise<{ durationSeconds: number; chapters: Mp4Chapter[] | null }> {
  const container = containerOf(file);
  const fetchRange = (start: number, end: number) => provider.fetchByteRange(file.boxFileId, start, end);
  const size = file.sizeBytes as number;

  if (container === "mp3") {
    const { durationSeconds, chapters } = await probeMp3(fetchRange, size, { chapters: true });
    return { durationSeconds, chapters };
  }
  const { durationSeconds, chapters } = await probeMp4(fetchRange, size, {
    chapters: AUDIO_MP4_CONTAINERS.has(container),
  });
  return { durationSeconds, chapters };
}

/**
 * Probes each file's duration (and embedded chapters, for audio), updating
 * probe state as it goes. Shared by the library-wide prober and the
 * single-title resync. Several files are probed at once; stops early (and
 * reports incomplete) if the deadline is hit between batches.
 */
export async function probeFiles(
  provider: StorageProvider,
  files: MediaFileRow[],
  deadline: number,
  errors: string[]
): Promise<boolean> {
  const probeable = files.filter((f) => f.sizeBytes);

  for (let i = 0; i < probeable.length; i += PROBE_CONCURRENCY) {
    if (Date.now() > deadline) return true;
    const batch = probeable.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((file) => probeAndRecord(provider, file, errors)));
    for (const r of results) {
      // A dead Box connection fails every file the same way; surface it once.
      if (r.status === "rejected" && r.reason instanceof BoxReauthRequiredError) throw r.reason;
    }
  }
  return false;
}

async function probeAndRecord(provider: StorageProvider, file: MediaFileRow, errors: string[]) {
  const attempts = file.probeAttempts + 1;
  try {
    const { durationSeconds, chapters } = await probeOne(provider, file);
    const durationMs = Math.round(durationSeconds * 1000);
    await db
      .update(mediaFiles)
      .set({
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        probeStatus: "ok",
        probeAttempts: attempts,
        chapters,
      })
      .where(eq(mediaFiles.id, file.id));
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) throw err;
    errors.push(`probe ${file.filename}: ${(err as Error).message}`);

    const estimateMs =
      attempts >= MAX_PROBE_ATTEMPTS ? estimateAudioDurationMs(containerOf(file), file.sizeBytes ?? 0) : null;
    await db
      .update(mediaFiles)
      .set({
        probeStatus: "failed",
        probeAttempts: attempts,
        ...(estimateMs !== null
          ? { durationMs: estimateMs, durationSeconds: Math.round(estimateMs / 1000) }
          : {}),
      })
      .where(eq(mediaFiles.id, file.id));
  }
}

/** SQL condition for files still worth probing: never probed, or failed with attempts to spare. */
export const pendingProbeCondition = or(
  eq(mediaFiles.probeStatus, "pending"),
  and(eq(mediaFiles.probeStatus, "failed"), lt(mediaFiles.probeAttempts, MAX_PROBE_ATTEMPTS))
)!;

/** Recomputes a title's total runtime from its segments, once every segment has a duration. */
export async function rollupTitleRuntime(titleId: string) {
  const segments = await db
    .select({ durationMs: mediaFiles.durationMs, durationSeconds: mediaFiles.durationSeconds })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId)));
  if (segments.length === 0 || segments.some((s) => s.durationSeconds == null)) return;
  const totalMs = segments.reduce((sum, s) => sum + (s.durationMs ?? (s.durationSeconds ?? 0) * 1000), 0);
  await db
    .update(titles)
    .set({ runtimeSeconds: Math.round(totalMs / 1000) })
    .where(eq(titles.id, titleId));
}
