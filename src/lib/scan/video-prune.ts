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

/** The cap: small removals always go through; a large share of the library, or a large absolute number, does not. */
export function tooManyToRemove(candidates: number, total: number): boolean {
  if (candidates > PRUNE_MAX_ABSOLUTE) return true;
  return candidates > PRUNE_FRACTION_FLOOR && candidates > total * PRUNE_MAX_FRACTION;
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
  deadline: number
): Promise<PruneResult> {
  const result: PruneResult = { removed: 0, candidates: 0, unverified: 0, skipped: null };
  if (!provider.fileExists) return { ...result, skipped: "unsupported" };
  const fileExists = provider.fileExists.bind(provider);

  // Claim it: only a still-current, still-clean cycle may be pruned, and only once.
  const claimed = await db
    .update(libraries)
    .set({ scanCycleClean: false })
    .where(and(eq(libraries.id, libraryId), eq(libraries.scanCycleId, cycleId), eq(libraries.scanCycleClean, true)))
    .returning({ id: libraries.id });
  if (claimed.length === 0) return { ...result, skipped: "not_clean" };

  const unseen = and(
    eq(titles.libraryId, libraryId),
    eq(titles.kind, "movie"),
    sql`${titles.boxFolderId} LIKE 'file:%'`,
    sql`${titles.lastSeenCycle} IS DISTINCT FROM ${cycleId}`
  );
  const candidates = await db.select({ id: titles.id, key: titles.boxFolderId }).from(titles).where(unseen);
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(titles).where(eq(titles.libraryId, libraryId));
  if (tooManyToRemove(candidates.length, total)) return { ...result, skipped: "too_many" };

  // Ask Box about each candidate by id. Any answer but a definite "gone" keeps the video.
  const gone: string[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      result.unverified += candidates.length - i;
      break;
    }
    const settled = await Promise.allSettled(candidates.slice(i, i + CONCURRENCY).map((c) => fileExists(c.key.slice("file:".length))));
    for (const [j, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") {
        if (!outcome.value) gone.push(candidates[i + j].id);
      } else if (outcome.reason instanceof BoxReauthRequiredError) {
        throw outcome.reason;
      } else {
        result.unverified++;
      }
    }
  }

  await removeTitles(libraryId, gone);
  result.removed = gone.length;
  return result;
}

/** What the admin is told after a prune, or null for nothing worth saying. */
export function pruneNote(r: PruneResult): string | null {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (r.skipped === "too_many") {
    return `Cleanup skipped: ${r.candidates} videos look like they were removed from Box, which is more than is safe to remove automatically, so none were removed. Check that the Box folder is intact.`;
  }
  const parts: string[] = [];
  if (r.removed > 0) parts.push(`Removed ${r.removed} ${plural(r.removed, "video that is", "videos that are")} no longer in Box.`);
  if (r.unverified > 0) parts.push(`${r.unverified} ${plural(r.unverified, "video", "videos")} couldn't be checked against Box and ${plural(r.unverified, "was", "were")} kept.`);
  return parts.length ? parts.join(" ") : null;
}
