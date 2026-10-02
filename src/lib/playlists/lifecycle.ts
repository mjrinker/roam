import { and, eq, inArray, isNull, ne, notExists, or } from "drizzle-orm";
import { playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import type { Executor } from "./executor";
import { purgeOrphanPlaylists } from "./purge";

/**
 * Called inside the viewer-delete transaction BEFORE the viewer row goes (the
 * ON DELETE SET NULL would otherwise erase who the owner was): deletes this
 * viewer's private playlists that were never shared. Lock-select, then a
 * separate DELETE that re-checks "no members" against a fresh snapshot, so a
 * share committed meanwhile is never lost. Shared and public playlists stay and
 * become ownerless when the viewer row is deleted.
 */
export async function deleteOwnedUnsharedPlaylists(ex: Executor, viewerId: string): Promise<number> {
  const unshared = () =>
    and(
      eq(playlists.ownerViewerId, viewerId),
      eq(playlists.visibility, "private"),
      notExists(
        ex
          .select({ one: playlistMembers.id })
          .from(playlistMembers)
          .where(eq(playlistMembers.playlistId, playlists.id))
      )
    );
  const locked = await ex
    .select({ id: playlists.id })
    .from(playlists)
    .where(eq(playlists.ownerViewerId, viewerId))
    .orderBy(playlists.id)
    .for("update");
  if (locked.length === 0) return 0;
  const deleted = await ex
    .delete(playlists)
    .where(
      and(
        inArray(
          playlists.id,
          locked.map((l) => l.id)
        ),
        unshared()
      )
    )
    .returning({ id: playlists.id });
  return deleted.length;
}

/**
 * Called inside the viewer-delete transaction AFTER the viewer row is gone:
 * cascaded member rows are gone too, so ownerless private playlists whose last
 * member was this viewer can now be collected, on every server the account is on.
 */
export async function purgeOrphansForAccount(ex: Executor, accountId: string): Promise<number> {
  const servers = await ex
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.profileId, accountId));
  let total = 0;
  for (const { serverId } of servers) total += await purgeOrphanPlaylists(ex, serverId);
  return total;
}

/**
 * When a viewer hides itself on the server (`visibleOnServer` -> false), remove
 * its access to playlists owned by OTHER accounts (and to ownerless ones).
 * Shares to sibling profiles of its own account, playlists it owns, and shares
 * it granted are untouched; public playlists stay readable (that follows server
 * membership, not profile visibility). Returns the number of shares removed.
 */
export async function revokeCrossAccountShares(ex: Executor, viewerId: string, accountId: string): Promise<number> {
  const foreignPlaylists = ex
    .select({ id: playlists.id })
    .from(playlists)
    .leftJoin(viewers, eq(viewers.id, playlists.ownerViewerId))
    .where(or(isNull(playlists.ownerViewerId), ne(viewers.accountId, accountId)));
  const removed = await ex
    .delete(playlistMembers)
    .where(and(eq(playlistMembers.viewerId, viewerId), inArray(playlistMembers.playlistId, foreignPlaylists)))
    .returning({ id: playlistMembers.id });
  return removed.length;
}
