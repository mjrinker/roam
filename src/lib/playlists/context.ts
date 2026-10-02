import { and, eq } from "drizzle-orm";
import { playlistMembers, playlists, serverMembers, viewers } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { Executor } from "./executor";
import {
  capabilities,
  type ActorFacts,
  type MemberRole,
  type PlaylistCapabilities,
  type PlaylistFacts,
} from "./permissions";

export type PlaylistRow = typeof playlists.$inferSelect;
export type ViewerRow = typeof viewers.$inferSelect;

export interface PlaylistContext {
  playlist: PlaylistRow;
  /** The ACTING viewer, freshly read (never a request-cached copy). */
  viewer: ViewerRow;
  access: AccessProfile;
  actor: ActorFacts;
  memberRole: MemberRole | null;
  caps: PlaylistCapabilities;
}

/**
 * Reads everything the permission rules need, in one place. For a mutation call
 * it inside a transaction with `lock: true` so the playlist row is locked first
 * and every fact below is read under that lock; a result computed before the
 * lock is never trusted. Returns null when the playlist or actor is gone, or
 * when the actor may not see the playlist at all (callers answer 404).
 */
export async function loadContext(
  ex: Executor,
  args: { playlistId: string; viewerId: string; lock?: boolean }
): Promise<PlaylistContext | null> {
  const base = ex.select().from(playlists).where(eq(playlists.id, args.playlistId));
  const [playlist] = await (args.lock ? base.for("update") : base);
  if (!playlist) return null;

  const [viewer] = await ex.select().from(viewers).where(eq(viewers.id, args.viewerId));
  if (!viewer) return null;

  const [membership] = await ex
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, playlist.serverId), eq(serverMembers.profileId, viewer.accountId)));

  let ownerAccountIsMember = false;
  if (playlist.ownerViewerId) {
    const [owner] = await ex
      .select({ one: serverMembers.id })
      .from(viewers)
      .innerJoin(serverMembers, eq(serverMembers.profileId, viewers.accountId))
      .where(and(eq(viewers.id, playlist.ownerViewerId), eq(serverMembers.serverId, playlist.serverId)));
    ownerAccountIsMember = Boolean(owner);
  }

  const [member] = await ex
    .select({ role: playlistMembers.role })
    .from(playlistMembers)
    .where(and(eq(playlistMembers.playlistId, playlist.id), eq(playlistMembers.viewerId, viewer.id)));

  const facts: PlaylistFacts = {
    ownerViewerId: playlist.ownerViewerId,
    ownerAccountIsMember,
    visibility: playlist.visibility,
  };
  const actor: ActorFacts = {
    viewerId: viewer.id,
    accountId: viewer.accountId,
    viewerRole: viewer.role,
    isServerMember: Boolean(membership),
    isServerAdmin: membership?.role === "admin",
  };
  const memberRole = member?.role ?? null;
  const caps = capabilities(facts, actor, memberRole);
  if (!caps.canView) return null;

  return {
    playlist,
    viewer,
    access: { locale: viewer.locale, maxAge: viewer.maxAge, allowUnrated: viewer.allowUnrated },
    actor,
    memberRole,
    caps,
  };
}
