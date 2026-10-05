/**
 * DB-side state machine for the "Fix audio" remux jobs (see lib/remux/).
 * A job is one distinct Box file: every media_files row sharing that file
 * (a combined multi-episode file has one per episode) moves through
 * remux_status together, keyed by one random per-job token that guards every
 * write the job makes — so a superseded/zombie job's late writes are no-ops.
 *
 * Everything here is scoped to ONE title's own owner ids, never a bare
 * cross-server box_file_id match.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { UNSUPPORTED_AUDIO_CODECS } from "@/lib/scan/codec-support";
import { variantFileName } from "@/lib/scan/conventions";
import { pendingCodecProbeCondition, probeCodecsForPending, upsertVariant } from "@/lib/scan/media-files";
import { createBoxProviderForServer, getBoxFileEntry } from "@/lib/storage/box";

export const MAX_REMUX_ATTEMPTS = 3;
/** Inputs at/under this size are remuxed inline in a function (peak /tmp use is ~2x the file); bigger ones go to a sandbox. */
export const TIER1_MAX_BYTES = 150 * 1024 * 1024;
/** How long an in_progress job may run before queueRemux treats it as dead. Just past each tier's own hard limit. */
export const TIER1_BUDGET_MS = 320_000;
export const TIER2_BUDGET_MS = 50 * 60_000;
/** An 'uploaded' job that never got linked (crash between upload and DB write) is retried after this. */
export const UPLOADED_STALE_MS = 10 * 60_000;

// ── Scope ────────────────────────────────────────────────────────────────

export type RemuxScope = { ownerKind: "title" | "episode"; ownerIds: string[]; serverId: string };

/** The owner rows a title's remux jobs cover: the movie itself, or every episode of a show. Audiobooks are out of scope. */
export async function resolveRemuxScope(titleId: string): Promise<RemuxScope | null> {
  const [title] = await db
    .select({ kind: titles.kind, serverId: libraries.serverId })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(titles.id, titleId))
    .limit(1);
  // Only movies and shows have audio worth remuxing: audiobooks, photos and anything added later are refused.
  if (!title || (title.kind !== "movie" && title.kind !== "show")) return null;
  if (title.kind === "movie") return { ownerKind: "title", ownerIds: [titleId], serverId: title.serverId };

  const eps = await db
    .select({ id: episodes.id })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .where(eq(seasons.titleId, titleId));
  return { ownerKind: "episode", ownerIds: eps.map((e) => e.id), serverId: title.serverId };
}

export type OwnerContext = { titleId: string; serverId: string; folderId: string };

/** Where an owner's files live: its title, server, and the Box folder a variant should be uploaded into (a movie's folder, or the episode's season folder). */
export async function resolveOwnerContext(
  ownerKind: "title" | "episode",
  ownerId: string
): Promise<OwnerContext | null> {
  if (ownerKind === "title") {
    const [row] = await db
      .select({ titleId: titles.id, folderId: sql<string>`coalesce(${titles.parentFolderId}, ${titles.boxFolderId})`, serverId: libraries.serverId })
      .from(titles)
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(eq(titles.id, ownerId))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({
      titleId: seasons.titleId,
      episodeFolderId: episodes.boxFolderId,
      seasonFolderId: seasons.boxFolderId,
      serverId: libraries.serverId,
    })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(episodes.id, ownerId))
    .limit(1);
  if (!row) return null;
  return { titleId: row.titleId, serverId: row.serverId, folderId: row.episodeFolderId ?? row.seasonFolderId };
}

// ── Eligibility (SQL, shared by queueRemux's read and its compare-and-set write) ──

const flagged = () =>
  and(eq(mediaFiles.codecProbed, true), inArray(mediaFiles.audioCodec, [...UNSUPPORTED_AUDIO_CODECS]))!;

/** in_progress/uploaded rows that have outlived their budget — the job is presumed dead. */
function stalled(now: Date) {
  const t1 = new Date(now.getTime() - TIER1_BUDGET_MS);
  const t2 = new Date(now.getTime() - TIER2_BUDGET_MS);
  const uploaded = new Date(now.getTime() - UPLOADED_STALE_MS);
  return or(
    and(
      eq(mediaFiles.remuxStatus, "in_progress"),
      or(
        isNull(mediaFiles.remuxStartedAt),
        and(or(isNull(mediaFiles.remuxTier), eq(mediaFiles.remuxTier, 1)), lt(mediaFiles.remuxStartedAt, t1)),
        and(eq(mediaFiles.remuxTier, 2), lt(mediaFiles.remuxStartedAt, t2))
      )
    ),
    and(
      eq(mediaFiles.remuxStatus, "uploaded"),
      or(isNull(mediaFiles.remuxStartedAt), lt(mediaFiles.remuxStartedAt, uploaded))
    )
  )!;
}

function scopeCondition(scope: RemuxScope) {
  return and(eq(mediaFiles.ownerKind, scope.ownerKind), inArray(mediaFiles.ownerId, scope.ownerIds))!;
}

function eligible(scope: RemuxScope, now: Date) {
  return and(
    scopeCondition(scope),
    flagged(),
    or(
      isNull(mediaFiles.remuxStatus),
      and(eq(mediaFiles.remuxStatus, "failed"), lt(mediaFiles.remuxAttempts, MAX_REMUX_ATTEMPTS)),
      eq(mediaFiles.remuxStatus, "pending"),
      and(stalled(now), lt(mediaFiles.remuxAttempts, MAX_REMUX_ATTEMPTS))
    )
  )!;
}

/**
 * Reads the codecs of this title's already-duration-probed files that the
 * background backfill hasn't reached yet, so a just-clicked "Fix audio"
 * doesn't wait on the backfill's own pacing.
 */
export async function probeCodecsForTitle(titleId: string, budgetMs = 30_000): Promise<void> {
  const scope = await resolveRemuxScope(titleId);
  if (!scope || scope.ownerIds.length === 0) return;
  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(scopeCondition(scope), pendingCodecProbeCondition));
  if (rows.length === 0) return;
  await probeCodecsForPending(createBoxProviderForServer(scope.serverId), rows, Date.now() + budgetMs);
}

// ── Queueing ─────────────────────────────────────────────────────────────

export type QueueResult = {
  /** Distinct Box files (re)queued by this call. */
  queued: number;
  /** Distinct Box files that already have a linked browser-friendly copy. */
  alreadyDone: number;
  /** Distinct Box files that failed/stalled and have used up MAX_REMUX_ATTEMPTS. */
  exhausted: number;
  /** Distinct Box files in this title flagged as needing the fix at all. */
  flagged: number;
};

/**
 * Queues every flagged, not-yet-fixed file in a title, then ALWAYS fires the
 * background runner — even when nothing new was queued — so a click after a
 * lost trigger (rows stuck 'pending') or a dead job still recovers.
 *
 * Each requeue repeats the eligibility test in its own WHERE, so a row a
 * concurrent claim just moved to in_progress is left alone rather than
 * stomped back to pending under a new token.
 */
export async function queueRemux(titleId: string, now = new Date()): Promise<QueueResult> {
  const scope = await resolveRemuxScope(titleId);
  const result: QueueResult = { queued: 0, alreadyDone: 0, exhausted: 0, flagged: 0 };
  if (!scope || scope.ownerIds.length === 0) return result;

  const flaggedRows = await db
    .select({ boxFileId: mediaFiles.boxFileId, remuxStatus: mediaFiles.remuxStatus })
    .from(mediaFiles)
    .where(and(scopeCondition(scope), flagged()));
  result.flagged = new Set(flaggedRows.map((r) => r.boxFileId)).size;
  result.alreadyDone = new Set(flaggedRows.filter((r) => r.remuxStatus === "done").map((r) => r.boxFileId)).size;

  const eligibleIds = await db
    .selectDistinct({ boxFileId: mediaFiles.boxFileId })
    .from(mediaFiles)
    .where(eligible(scope, now));
  for (const { boxFileId } of eligibleIds) {
    const updated = await db
      .update(mediaFiles)
      .set({ remuxStatus: "pending", remuxCallbackToken: randomUUID() })
      .where(and(eligible(scope, now), eq(mediaFiles.boxFileId, boxFileId)))
      .returning({ id: mediaFiles.id });
    if (updated.length > 0) result.queued++;
  }

  const exhausted = await db
    .selectDistinct({ boxFileId: mediaFiles.boxFileId })
    .from(mediaFiles)
    .where(
      and(
        scopeCondition(scope),
        flagged(),
        sql`${mediaFiles.remuxAttempts} >= ${MAX_REMUX_ATTEMPTS}`,
        or(eq(mediaFiles.remuxStatus, "failed"), stalled(now))
      )
    );
  result.exhausted = exhausted.length;

  await triggerRemuxRun(titleId);
  return result;
}

/** Fire-and-forget POST to the runner route (same pattern as the scanner's chained passes); errors are swallowed — queueRemux re-fires on the next click. */
export async function triggerRemuxRun(titleId: string): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!baseUrl || !secret) return;
  try {
    await fetch(new URL("/api/remux/run", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ titleId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`Couldn't trigger the remux runner for title ${titleId}:`, err);
  }
}

// ── Claiming ─────────────────────────────────────────────────────────────

export type RemuxJob = {
  jobToken: string;
  titleId: string;
  serverId: string;
  /** Upload target: the folder the original sits in. */
  folderId: string;
  boxFileId: string;
  /** media_files ids (primaries) this job covers. */
  rowIds: string[];
  sizeBytes: number | null;
  tier: 1 | 2;
  outputName: string;
};

/**
 * Claims ONE pending Box file in a title. The row lock is taken with a
 * deterministic ORDER BY id so two claimers within a title can't lock in
 * different orders; attempts are counted here (at claim) so a job that is
 * silently killed still counts against the cap.
 */
export async function claimNextJob(titleId: string): Promise<RemuxJob | null> {
  const scope = await resolveRemuxScope(titleId);
  if (!scope || scope.ownerIds.length === 0) return null;

  const claimed = await db.transaction(async (tx) => {
    const pending = await tx
      .select({
        id: mediaFiles.id,
        boxFileId: mediaFiles.boxFileId,
        filename: mediaFiles.filename,
        sizeBytes: mediaFiles.sizeBytes,
        token: mediaFiles.remuxCallbackToken,
        ownerId: mediaFiles.ownerId,
      })
      .from(mediaFiles)
      .where(and(scopeCondition(scope), eq(mediaFiles.remuxStatus, "pending")))
      .orderBy(asc(mediaFiles.id))
      .for("update");
    const first = pending[0];
    if (!first || !first.ownerId) return null;

    const group = pending.filter((r) => r.boxFileId === first.boxFileId && r.token === first.token);
    const token = first.token ?? randomUUID();
    const sizeBytes = group.every((r) => r.sizeBytes != null) ? Math.max(...group.map((r) => r.sizeBytes as number)) : null;
    const tier: 1 | 2 = sizeBytes != null && sizeBytes <= TIER1_MAX_BYTES ? 1 : 2;

    const updated = await tx
      .update(mediaFiles)
      .set({
        remuxStatus: "in_progress",
        remuxStartedAt: new Date(),
        remuxAttempts: sql`${mediaFiles.remuxAttempts} + 1`,
        remuxTier: tier,
        remuxCallbackToken: token,
      })
      .where(and(inArray(mediaFiles.id, group.map((r) => r.id)), eq(mediaFiles.remuxStatus, "pending")))
      .returning({ id: mediaFiles.id });
    if (updated.length === 0) return null;

    return { first, token, tier, sizeBytes, rowIds: updated.map((u) => u.id) };
  });
  if (!claimed) return null;

  const ctx = await resolveOwnerContext(scope.ownerKind, claimed.first.ownerId as string);
  if (!ctx) {
    await failRemuxJob(claimed.token, "owner or folder no longer exists");
    return null;
  }
  return {
    jobToken: claimed.token,
    titleId: ctx.titleId,
    serverId: ctx.serverId,
    folderId: ctx.folderId,
    boxFileId: claimed.first.boxFileId,
    rowIds: claimed.rowIds,
    sizeBytes: claimed.sizeBytes,
    tier: claimed.tier,
    outputName: variantFileName(claimed.first.filename),
  };
}

// ── Completion (every write guarded by the job token) ────────────────────

/** The live in_progress job a token belongs to — used to authenticate a sandbox's callbacks. Null if the token is unknown or superseded. */
export async function getActiveJobByToken(
  jobToken: string
): Promise<(OwnerContext & { boxFileId: string; rowIds: string[]; filename: string }) | null> {
  const rows = await db
    .select({
      id: mediaFiles.id,
      boxFileId: mediaFiles.boxFileId,
      filename: mediaFiles.filename,
      ownerKind: mediaFiles.ownerKind,
      ownerId: mediaFiles.ownerId,
    })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.remuxCallbackToken, jobToken), eq(mediaFiles.remuxStatus, "in_progress")));
  const first = rows[0];
  if (!first || !first.ownerKind || !first.ownerId) return null;
  const ctx = await resolveOwnerContext(first.ownerKind, first.ownerId);
  if (!ctx) return null;
  return { ...ctx, boxFileId: first.boxFileId, rowIds: rows.map((r) => r.id), filename: first.filename };
}

/** Marks a job failed. No-op if the token was superseded. Returns whether it applied. */
export async function failRemuxJob(jobToken: string, reason: string): Promise<boolean> {
  console.error(`Remux job failed: ${reason}`);
  const updated = await db
    .update(mediaFiles)
    .set({ remuxStatus: "failed" })
    .where(and(eq(mediaFiles.remuxCallbackToken, jobToken), eq(mediaFiles.remuxStatus, "in_progress")))
    .returning({ id: mediaFiles.id });
  return updated.length > 0;
}

export type UploadedFile = { id: string; name?: string; size?: number };

/**
 * Records a successful upload: 'uploaded', then links the variant (which is
 * what flips it to 'done'). Returns whether the write applied — false means
 * the job was superseded and this result is discarded.
 */
export async function completeRemuxJob(jobToken: string, uploaded: UploadedFile): Promise<boolean> {
  const job = await getActiveJobByToken(jobToken);
  if (!job) return false;

  const name = uploaded.name ?? variantFileName(job.filename);
  let size = uploaded.size;
  if (size == null) {
    const entry = await getBoxFileEntry(job.serverId, uploaded.id);
    if (!entry) {
      await failRemuxJob(jobToken, `uploaded file ${uploaded.id} not found in Box`);
      return false;
    }
    size = entry.sizeBytes;
  }

  const marked = await db
    .update(mediaFiles)
    .set({ remuxStatus: "uploaded", remuxStartedAt: new Date() })
    .where(and(eq(mediaFiles.remuxCallbackToken, jobToken), eq(mediaFiles.remuxStatus, "in_progress")))
    .returning({ id: mediaFiles.id });
  if (marked.length === 0) return false;

  return upsertVariant(
    marked.map((m) => m.id),
    { id: uploaded.id, name, sizeBytes: size },
    jobToken
  );
}
