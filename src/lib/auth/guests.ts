/**
 * Guests: anonymous visitors let into the public demo with one click. A guest has an account like anyone
 * (so everything that keys on an account just works), but no real email, can only watch, and is deleted
 * after a stretch of inactivity so the demo doesn't pile up abandoned accounts.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { playlists, profiles, viewers } from "@/lib/db/schema";

/** A guest that hasn't loaded a page for this long is deleted. */
export const GUEST_INACTIVE_DAYS = 7;
const TOUCH_EVERY_MS = 60 * 60 * 1000;

/** A placeholder address for a guest: syntactically valid, in a domain reserved to never exist (RFC 2606), so nothing is ever sent to it. */
export const guestEmail = (userId: string) => `guest-${userId}@guest.invalid`;

export const isGuestProfile = (p: { isGuest: boolean } | null | undefined): boolean => !!p?.isGuest;

/** What a guest's account shows instead of its placeholder address. */
export const accountLabel = (p: { isGuest: boolean; email: string }) => (p.isGuest ? "Guest" : p.email);

/** Records that a guest was seen, at most once an hour (this runs on page loads). */
export async function touchGuest(p: { id: string; isGuest: boolean; lastSeenAt: Date | null }, now = new Date()): Promise<void> {
  if (!p.isGuest) return;
  if (p.lastSeenAt && now.getTime() - p.lastSeenAt.getTime() < TOUCH_EVERY_MS) return;
  await db
    .update(profiles)
    .set({ lastSeenAt: now })
    .where(and(eq(profiles.id, p.id), eq(profiles.isGuest, true)));
}

export interface CleanupResult {
  deleted: number;
  failed: number;
}

/**
 * Deletes guests that have been inactive for `days` (a guest never seen since joining counts from when it
 * was created), at most `limit` per call. Order matters: playlists a guest made survive their owner's deletion
 * (the owner column is "set null"), so those go first; then the account row, which cascades to the profiles,
 * memberships, watch history, favorites and rate-limit rows; and only then the sign-in record, so a failure
 * in the middle never leaves a working login with no data behind it.
 */
export async function deleteInactiveGuests(
  deleteAuthUser: (id: string) => Promise<void>,
  opts: { now?: Date; days?: number; limit?: number } = {}
): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.days ?? GUEST_INACTIVE_DAYS) * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.isGuest, true), lt(sql`coalesce(${profiles.lastSeenAt}, ${profiles.createdAt})`, cutoff)))
    .limit(opts.limit ?? 20);

  const result: CleanupResult = { deleted: 0, failed: 0 };
  for (const { id } of stale) {
    try {
      const removed = await db.transaction(async (tx) => {
        // Re-checked and locked in the same transaction: only a guest, and only if still inactive (it may have come back).
        const [still] = await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(and(eq(profiles.id, id), eq(profiles.isGuest, true), lt(sql`coalesce(${profiles.lastSeenAt}, ${profiles.createdAt})`, cutoff)))
          .for("update");
        if (!still) return false;
        const theirs = await tx.select({ id: viewers.id }).from(viewers).where(eq(viewers.accountId, id));
        if (theirs.length > 0) await tx.delete(playlists).where(inArray(playlists.ownerViewerId, theirs.map((v) => v.id)));
        await tx.delete(profiles).where(eq(profiles.id, id));
        return true;
      });
      if (!removed) continue;
      await deleteAuthUser(id);
      result.deleted++;
    } catch {
      result.failed++; // e.g. it owns a server (refused at creation, so this should not happen); left for the next run
    }
  }
  return result;
}
