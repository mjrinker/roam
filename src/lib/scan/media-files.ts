import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  AUDIO_MP4_CONTAINERS,
  containerOf,
  estimateAudioDurationMs,
} from "@/lib/scan/containers";
import { parseEpisodeFileName, stripVariantSuffix } from "@/lib/scan/conventions";
import { probeMp3 } from "@/lib/scan/mp3-duration";
import { probeMp4, probeMp4Codecs, type Mp4Chapter } from "@/lib/scan/mp4-duration";

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
          // Scoped to the owner too (not just boxFileId), so a multi-episode
          // file's second (third, ...) owner upserting the same Box file
          // gets its OWN row instead of stealing/overwriting the first
          // owner's. Requires media_files_owner_file_idx (Deploy 1) plus the
          // global box_file_id unique dropped (Deploy 2) — see the rollout
          // plan in episode-split-pass.ts's module doc comment.
          target: [mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId],
          set: { partIndex: i, filename: file.name, sizeBytes: file.sizeBytes },
        });
    }
  });
}

// ── Browser-friendly variants ────────────────────────────────────────────
// A variant row is a remuxed copy of one primary row's file (see
// lib/remux/). It carries only its own Box file's identity + probe state;
// trims and playback order always come from the primary row.

/**
 * Links a variant file to every primary row that shares the original's Box
 * file (a combined multi-episode file has one row per episode), and marks
 * each primary's remux job 'done'. This is the ONLY place remuxStatus
 * becomes 'done' — so 'done' always means "actually linked and visible".
 *
 * `jobToken` is passed by the remux job's own fast path, making the whole
 * write a no-op if the job was superseded (its token rotated). The
 * scanner's rediscovery path has no job context and omits it.
 * Returns false only when the token guard rejected the write.
 */
export async function upsertVariant(
  primaryRowIds: string[],
  file: Pick<StorageEntry, "id" | "name" | "sizeBytes">,
  jobToken?: string
): Promise<boolean> {
  if (primaryRowIds.length === 0) return true;
  return db.transaction(async (tx) => {
    const guard = jobToken
      ? and(inArray(mediaFiles.id, primaryRowIds), eq(mediaFiles.remuxCallbackToken, jobToken))
      : inArray(mediaFiles.id, primaryRowIds);
    const primaries = await tx.select({ id: mediaFiles.id }).from(mediaFiles).where(guard);
    if (primaries.length === 0) return false;

    const container = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
    for (const { id } of primaries) {
      await tx
        .insert(mediaFiles)
        .values({
          ownerKind: null,
          ownerId: null,
          boxFileId: file.id,
          filename: file.name,
          sizeBytes: file.sizeBytes,
          container,
          variantOfMediaFileId: id,
        })
        .onConflictDoUpdate({
          target: mediaFiles.variantOfMediaFileId,
          // A different Box file than before (re-remuxed) invalidates the
          // old probe; the same file re-linked leaves probe state alone.
          setWhere: sql`${mediaFiles.boxFileId} <> excluded.box_file_id`,
          set: {
            boxFileId: file.id,
            filename: file.name,
            sizeBytes: file.sizeBytes,
            container,
            probeStatus: "pending",
            probeAttempts: 0,
            durationMs: null,
            durationSeconds: null,
            codecProbed: false,
            codecProbeAttempts: 0,
          },
        });
    }
    await tx
      .update(mediaFiles)
      .set({ remuxStatus: "done" })
      .where(inArray(mediaFiles.id, primaries.map((p) => p.id)));
    return true;
  });
}

/**
 * Scanner-side rediscovery of variant files sitting in one movie/season
 * folder: links each to the primary rows of its original (matched by exact
 * original filename), and deletes links whose Box file has vanished
 * (resetting the primary's remux state so "Fix audio" is offered again).
 * `ownerIds` scopes everything to this folder's own titles/episodes — never
 * a bare Box-file-id match across servers. Must run AFTER the folder's
 * primary rows are final (stale-episode deletion included), since deleting a
 * primary cascades away its variant.
 */
export async function linkVariantFiles(
  ownerKind: "title" | "episode",
  ownerIds: string[],
  normalFiles: StorageEntry[],
  variantFiles: StorageEntry[]
): Promise<void> {
  if (ownerIds.length === 0) return;

  const primaryRows = await db
    .select({ id: mediaFiles.id, boxFileId: mediaFiles.boxFileId })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), inArray(mediaFiles.ownerId, ownerIds)));

  const normalByName = new Map(normalFiles.map((f) => [f.name.toLowerCase(), f]));
  for (const variant of variantFiles) {
    const original = normalByName.get(stripVariantSuffix(variant.name).toLowerCase());
    if (!original) continue;
    const ids = primaryRows.filter((r) => r.boxFileId === original.id).map((r) => r.id);
    await upsertVariant(ids, variant);
  }

  if (primaryRows.length === 0) return;
  const liveVariantIds = variantFiles.map((f) => f.id);
  const orphaned = await db
    .delete(mediaFiles)
    .where(
      and(
        inArray(mediaFiles.variantOfMediaFileId, primaryRows.map((r) => r.id)),
        liveVariantIds.length > 0 ? notInArray(mediaFiles.boxFileId, liveVariantIds) : undefined
      )
    )
    .returning({ primaryId: mediaFiles.variantOfMediaFileId });
  const resetIds = orphaned.map((o) => o.primaryId).filter((id): id is string => id !== null);
  if (resetIds.length > 0) {
    await db.update(mediaFiles).set({ remuxStatus: null }).where(inArray(mediaFiles.id, resetIds));
  }
}

const primaryFiles = alias(mediaFiles, "primary_files");

/** Variant rows whose PRIMARY belongs to one of these owners — variants have no owner of their own, so a plain owner-id filter can never match them. */
export function variantScope(ownerKind: "title" | "episode", ownerIds: string[]) {
  return inArray(
    mediaFiles.variantOfMediaFileId,
    db
      .select({ id: primaryFiles.id })
      .from(primaryFiles)
      .where(and(eq(primaryFiles.ownerKind, ownerKind), inArray(primaryFiles.ownerId, ownerIds)))
  );
}

// ── Probing ──────────────────────────────────────────────────────────────

/** After this many failed tries a part is given up on (see estimateAudioDurationMs). */
export const MAX_PROBE_ATTEMPTS = 3;
const PROBE_CONCURRENCY = 3;

interface ProbeOneResult {
  durationSeconds: number;
  chapters: Mp4Chapter[] | null;
  audioCodec: string | null;
  videoCodec: string | null;
  /** False only if the codec read itself hit an unexpected error — distinct from a clean read that found no such track. See probeAndRecord. */
  codecsProbed: boolean;
}

async function probeOne(provider: StorageProvider, file: MediaFileRow): Promise<ProbeOneResult> {
  const container = containerOf(file);
  const fetchRange = (start: number, end: number) => provider.fetchByteRange(file.boxFileId, start, end);
  const size = file.sizeBytes as number;

  if (container === "mp3") {
    const { durationSeconds, chapters } = await probeMp3(fetchRange, size, { chapters: true });
    // mp3 has no video track and only one real audio codec worth naming —
    // browser-universal, so it's never a candidate for the audio-fix remux.
    return { durationSeconds, chapters, audioCodec: "mp3", videoCodec: null, codecsProbed: true };
  }
  // Chapters are also worth extracting for a multi-episode video file (e.g.
  // "S01E05-E06.mp4") — the episode-split pass uses them to snap its
  // estimated cut point to a real scene boundary. Narrowed to just those
  // files (rather than every video) so this doesn't add extra Box range
  // requests, or a new chance to throw on a malformed moov, to every
  // ordinary movie/episode probe. Codec detection itself is unconditional
  // (see mp4-duration.ts's module doc comment) — it runs regardless.
  const isMultiEpisode =
    file.ownerKind === "episode" && (parseEpisodeFileName(file.filename)?.episodes.length ?? 0) > 1;
  const { durationSeconds, chapters, audioCodec, videoCodec, codecsProbed } = await probeMp4(fetchRange, size, {
    chapters: AUDIO_MP4_CONTAINERS.has(container) || isMultiEpisode,
  });
  return { durationSeconds, chapters, audioCodec, videoCodec, codecsProbed };
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
    const { durationSeconds, chapters, audioCodec, videoCodec, codecsProbed } = await probeOne(provider, file);
    const durationMs = Math.round(durationSeconds * 1000);
    await db
      .update(mediaFiles)
      .set({
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        probeStatus: "ok",
        probeAttempts: attempts,
        chapters,
        // codecsProbed is its own success signal, independent of the
        // surrounding duration probe having succeeded — a failed codec read
        // (a malformed track) must NOT be recorded as "probed, found
        // nothing" (codecProbed: true with null codecs), since that would
        // permanently hide a real codec issue behind "unknown = safe". Left
        // false, it's picked up and retried by the backfill pass below.
        ...(codecsProbed ? { audioCodec, videoCodec, codecProbed: true } : {}),
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

// ── Codec backfill ───────────────────────────────────────────────────────
// A row's audio/video codec is written inline by probeAndRecord above for
// any file probed after codec detection shipped. This backfills the two
// cases that misses: a row whose duration was already probed (probeStatus
// already 'ok') before this feature existed, and a row whose inline codec
// read specifically failed (left codecProbed=false on purpose, above).
// Deliberately its own counter/condition, entirely separate from
// probeStatus/probeAttempts — a transient error here must never regress an
// already-working duration probe.

export const MAX_CODEC_PROBE_ATTEMPTS = 3;

/** SQL condition for rows worth a codec backfill: duration already known, codec not yet successfully read. */
export const pendingCodecProbeCondition = and(
  eq(mediaFiles.probeStatus, "ok"),
  eq(mediaFiles.codecProbed, false)
)!;

async function probeCodecsOnly(provider: StorageProvider, file: MediaFileRow) {
  const attempts = file.codecProbeAttempts + 1;
  const fetchRange = (start: number, end: number) => provider.fetchByteRange(file.boxFileId, start, end);
  try {
    const { audioCodec, videoCodec, codecsProbed } = await probeMp4Codecs(fetchRange, file.sizeBytes as number);
    if (codecsProbed) {
      await db
        .update(mediaFiles)
        .set({ audioCodec, videoCodec, codecProbed: true, codecProbeAttempts: attempts })
        .where(eq(mediaFiles.id, file.id));
      return;
    }
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) throw err;
  }
  // Either the read failed outright, or came back but codecsProbed was
  // false (a malformed track) — give it up to MAX_CODEC_PROBE_ATTEMPTS real
  // chances before treating it as permanently unknown (safe/untouched)
  // rather than either retrying forever or writing it off on one hiccup.
  await db
    .update(mediaFiles)
    .set({
      codecProbeAttempts: attempts,
      ...(attempts >= MAX_CODEC_PROBE_ATTEMPTS ? { codecProbed: true } : {}),
    })
    .where(eq(mediaFiles.id, file.id));
}

/**
 * Runs the codec backfill over a batch of already-duration-probed rows,
 * under its own deadline (a slice of the caller's remaining scan time
 * budget) so it can't run unbounded on a large pre-existing library —
 * leftover work simply continues on the next scan pass. Deliberately
 * doesn't report "incomplete"/trigger extra chaining the way probeFiles
 * does: this is a one-time backfill, not core scan work.
 */
export async function probeCodecsForPending(
  provider: StorageProvider,
  files: MediaFileRow[],
  deadline: number
): Promise<void> {
  for (const file of files) {
    if (Date.now() > deadline) return;
    if (!file.sizeBytes) continue;
    await probeCodecsOnly(provider, file);
  }
}

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
