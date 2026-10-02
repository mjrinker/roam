import { and, eq, inArray, isNull, notExists, or } from "drizzle-orm";
import { playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import type { Executor } from "./executor";

/** Private, never shared, and nobody can act as owner (no owner, or the owner's account left the server). */
function orphanCondition(serverId: string, ex: Executor) {
  const hasMember = ex
    .select({ one: playlistMembers.id })
    .from(playlistMembers)
    .where(eq(playlistMembers.playlistId, playlists.id));
  const ownerStillOnServer = ex
    .select({ one: viewers.id })
    .from(viewers)
    .innerJoin(serverMembers, eq(serverMembers.profileId, viewers.accountId))
    .where(and(eq(viewers.id, playlists.ownerViewerId), eq(serverMembers.serverId, playlists.serverId)));
  return and(
    eq(playlists.serverId, serverId),
    eq(playlists.visibility, "private"),
    notExists(hasMember),
    or(isNull(playlists.ownerViewerId), notExists(ownerStillOnServer))
  );
}

/**
 * Deletes unshared private playlists on `serverId` that nobody can own any
 * more. Idempotent. It locks the candidates first and deletes in a SEPARATE
 * statement that re-checks "no members": under READ COMMITTED the second
 * statement gets a fresh snapshot, so a share committed in between is seen and
 * the playlist survives. Returns the number deleted.
 */
export async function purgeOrphanPlaylists(ex: Executor, serverId: string): Promise<number> {
  const candidates = await ex
    .select({ id: playlists.id })
    .from(playlists)
    .where(orphanCondition(serverId, ex))
    .orderBy(playlists.id)
    .for("update");
  if (candidates.length === 0) return 0;

  const deleted = await ex
    .delete(playlists)
    .where(
      and(
        inArray(
          playlists.id,
          candidates.map((c) => c.id)
        ),
        orphanCondition(serverId, ex)
      )
    )
    .returning({ id: playlists.id });
  return deleted.length;
}
