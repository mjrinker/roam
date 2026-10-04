/**
 * Removing videos that have left Box. This deletes watch history and playlist entries, so it is
 * deliberately slow to act:
 *
 * - Only after a scan CYCLE that finished cleanly: every pass of the cycle walked its directories
 *   without a single listing or write error (any error marks the cycle unclean), and the cycle was
 *   never superseded. The pass that finishes the cycle claims the prune by flipping the cycle to
 *   unclean in one conditional UPDATE, so exactly one pass ever prunes a given cycle.
 * - A video is a candidate only if it wasn't SEEN (stamped) in that cycle. A listing is never trusted
 *   alone: Box listings aren't atomic across a long cycle (a file moved from a directory not yet
 *   visited into one already visited is seen nowhere), so each candidate is asked about by its Box id,
 *   and removed only if Box says it is gone or trashed. Any other answer or error keeps it.
 * - A cap: if a suspicious number of videos look removed (a wrong folder, an outage, someone moved
 *   the whole library), nothing is removed and the admin is told.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageProvider } from "@/lib/storage/provider";
import { VIDEO_PROFILE, type TreeProfile } from "@/lib/scan/tree-profile";

/**
 * A video must stay gone this long before it is removed. Box's trash is restorable for weeks, and a
 * 404 can also mean "this account can no longer see it" (a permissions change), so the first scan that
 * finds a video missing only notes it (`missing_since`); it is removed once it has stayed gone this long.
 * Tests set `graceMs` to 0 to remove immediately.
 */
export const pruneSettings = { graceMs: 3 * 24 * 60 * 60 * 1000 };

/** Never ask Box about more candidates than this in one cycle: a reorganisation that big is left alone. */
export const PRUNE_VERIFY_MAX = 1000;
/** Never remove more than this many in one cycle. */
export const PRUNE_MAX_ABSOLUTE = 500;
/** Above this many candidates, never remove more than this share of the library. */
export const PRUNE_FRACTION_FLOOR = 20;
export const PRUNE_MAX_FRACTION = 0.2;
const CHUNK = 500;
const CONCURRENCY = 3;

export interface PruneResult {
  /** Videos removed. */
  removed: number;
  /** Videos not seen this cycle (before verifying them against Box). */
  candidates: number;
  /** Candidates Box couldn't answer about; kept. */
  unverified: number;
  /** Videos Box says are gone but that are still inside the grace period; kept for now. */
  waiting: number;
  skipped: "not_clean" | "too_many" | "unsupported" | null;
}

/** Flags the cycle as untrustworthy for removal. Does nothing if the library has moved on to a newer cycle. */
export async function markCycleUnclean(libraryId: string, cycleId: string | null): Promise<void> {
  if (cycleId === null) return;
  await db
    .update(libraries)
    .set({ scanCycleClean: false })
    .where(and(eq(libraries.id, libraryId), eq(libraries.scanCycleId, cycleId)));
}

/**
 * The cap, applied to videos Box CONFIRMED gone: small removals go through; a large share of the
 * library, a large absolute number, or the whole of a library that isn't tiny, does not (that looks like
 * a wrong folder, an outage or a permissions change, not a clean-up).
 */
export function tooManyToRemove(gone: number, total: number): boolean {
  if (gone > PRUNE_MAX_ABSOLUTE) return true;
  if (gone === total && total >= 5) return true;
  return gone > PRUNE_FRACTION_FLOOR && gone > total * PRUNE_MAX_FRACTION;
}

async function removeTitles(libraryId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await db.transaction(async (tx) => {
      // Remuxed copies have no owner of their own: they hang off their primary's row, so go first.
      await tx.delete(mediaFiles).where(
        inArray(
          mediaFiles.variantOfMediaFileId,
          tx
            .select({ id: mediaFiles.id })
            .from(mediaFiles)
            .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, chunk)))
        )
      );
      await tx.delete(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, chunk)));
      // Watch history is keyed to the title without a foreign key; playlist entries and artwork cascade with the title.
      await tx.delete(watchState).where(and(eq(watchState.ownerKind, "title"), inArray(watchState.ownerId, chunk)));
      await tx.delete(titles).where(and(inArray(titles.id, chunk), eq(titles.libraryId, libraryId)));
    });
  }
}

/**
 * Called by the pass that just finished a scan cycle's last directory. See the module comment for
 * every condition under which it does nothing.
 */
export async function pruneMissingVideos(
  provider: Pick<StorageProvider, "fileExists">,
  libraryId: string,
  cycleId: string,
  deadline: number,
  profile: TreeProfile = VIDEO_PROFILE
): Promise<PruneResult> {
  const result: PruneResult = { removed: 0, candidates: 0, unverified: 0, waiting: 0, skipped: null };
  if (!provider.fileExists) return { ...result, skipped: "unsupported" };
  const fileExists = provider.fileExists.bind(provider);

  // Claim it: only a still-current, still-clean cycle may be pruned, and only once.
  const claimed = await db
    .update(libraries)
    .set({ scanCycleClean: false })
    .where(
      and(
        eq(libraries.id, libraryId),
        eq(libraries.scanCycleId, cycleId),
        eq(libraries.scanCycleClean, true),
        // Read now, not at the start of the pass: switching cleanup off stops a pass that is already running.
        eq(libraries.pruneMissing, true)
      )
    )
    .returning({ id: libraries.id });
  if (claimed.length === 0) return { ...result, skipped: "not_clean" };

  const unseen = and(
    eq(titles.libraryId, libraryId),
    eq(titles.kind, profile.titleKind),
    sql`${titles.boxFolderId} LIKE 'file:%'`,
    sql`${titles.lastSeenCycle} IS DISTINCT FROM ${cycleId}`
  );
  const candidates = await db
    .select({ id: titles.id, key: titles.boxFolderId, missingSince: titles.missingSince })
    .from(titles)
    .where(unseen);
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;
  if (candidates.length > PRUNE_VERIFY_MAX) return { ...result, skipped: "too_many" };

  // Ask Box about each candidate by id. Any answer but a definite "gone" keeps the video.
  const gone: typeof candidates = [];
  const present: string[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      result.unverified += candidates.length - i;
      break;
    }
    const settled = await Promise.allSettled(candidates.slice(i, i + CONCURRENCY).map((c) => fileExists(c.key.slice("file:".length))));
    for (const [j, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") {
        if (outcome.value) present.push(candidates[i + j].id);
        else gone.push(candidates[i + j]);
      } else if (outcome.reason instanceof BoxReauthRequiredError) {
        throw outcome.reason;
      } else {
        result.unverified++;
      }
    }
  }

  // Still in Box (just not listed this time): whatever made it look missing is over.
  for (let i = 0; i < present.length; i += CHUNK) {
    await db.update(titles).set({ missingSince: null }).where(inArray(titles.id, present.slice(i, i + CHUNK)));
  }

  // Gone from Box: note when it was first missed; only a video that has stayed gone past the grace is due.
  const now = Date.now();
  const due = gone.filter((g) => pruneSettings.graceMs <= 0 || (g.missingSince !== null && g.missingSince.getTime() <= now - pruneSettings.graceMs));
  const newlyMissing = gone.filter((g) => g.missingSince === null).map((g) => g.id);
  for (let i = 0; i < newlyMissing.length; i += CHUNK) {
    await db.update(titles).set({ missingSince: new Date(now) }).where(inArray(titles.id, newlyMissing.slice(i, i + CHUNK)));
  }
  result.waiting = gone.length - due.length;

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(titles).where(eq(titles.libraryId, libraryId));
  if (due.length > 0 && tooManyToRemove(due.length, total)) return { ...result, skipped: "too_many", candidates: due.length };

  await removeTitles(libraryId, due.map((g) => g.id));
  result.removed = due.length;
  return result;
}

/** What the admin is told after a prune, or null for nothing worth saying. */
export function pruneNote(r: PruneResult, profile: TreeProfile = VIDEO_PROFILE): string | null {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const { one, many } = profile.noun;
  if (r.skipped === "too_many") {
    return `Cleanup skipped: ${r.candidates} ${many} look like they were removed from Box, which is more than is safe to remove automatically, so none were removed. Check that the Box folder is intact.`;
  }
  const parts: string[] = [];
  if (r.waiting > 0) parts.push(`${r.waiting} ${plural(r.waiting, `${one} is`, `${many} are`)} no longer in Box; ${plural(r.waiting, "it", "they")} will be removed from Roam if ${plural(r.waiting, "it stays", "they stay")} gone for ${Math.round(pruneSettings.graceMs / 86_400_000)} days.`);
  if (r.removed > 0) parts.push(`Removed ${r.removed} ${plural(r.removed, `${one} that is`, `${many} that are`)} no longer in Box.`);
  if (r.unverified > 0) parts.push(`${r.unverified} ${plural(r.unverified, one, many)} couldn't be checked against Box and ${plural(r.unverified, "was", "were")} kept.`);
  return parts.length ? parts.join(" ") : null;
}
