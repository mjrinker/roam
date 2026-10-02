/**
 * Who may do what with a playlist. Pure — callers read the facts (inside the
 * playlist row lock for any mutation) and pass them in. See the playlist plan
 * for the rules; the short version:
 *  - every path requires the actor's ACCOUNT to be a current member of the
 *    playlist's server;
 *  - roles rank owner > editor > sharer > viewer; a playlist with no owner (or
 *    whose owner's account left the server) is capped at viewer for everyone;
 *  - `visibility = 'server'` gives every server member viewer access;
 *  - `limited` profiles may never expand access beyond their own account;
 *  - a server admin may delete a PUBLIC playlist, and sees nothing else.
 */

export type PlaylistVisibility = "private" | "server";
export type MemberRole = "editor" | "sharer" | "viewer";
export type EffectiveRole = "owner" | MemberRole;
export type ViewerRole = "owner" | "admin" | "limited";

export interface PlaylistFacts {
  ownerViewerId: string | null;
  /** Whether the owner viewer's account still has a server_members row for this server. Ignored when there is no owner. */
  ownerAccountIsMember: boolean;
  visibility: PlaylistVisibility;
}

export interface ActorFacts {
  viewerId: string;
  accountId: string;
  viewerRole: ViewerRole;
  /** The actor's account is a CURRENT member of the playlist's server. */
  isServerMember: boolean;
  /** server_members.role === 'admin' for the actor's account on this server. */
  isServerAdmin: boolean;
}

export interface MemberRowFacts {
  viewerId: string;
  role: MemberRole;
  grantedByViewerId: string | null;
}

const RANK: Record<EffectiveRole, number> = { viewer: 0, sharer: 1, editor: 2, owner: 3 };

/** True when nobody can act as owner: no owner viewer, or the owner's account is no longer on the server. */
export function isOrphaned(playlist: PlaylistFacts): boolean {
  return playlist.ownerViewerId === null || !playlist.ownerAccountIsMember;
}

export function effectiveRole(
  playlist: PlaylistFacts,
  actor: ActorFacts,
  memberRole: MemberRole | null
): EffectiveRole | null {
  if (!actor.isServerMember) return null;

  let role: EffectiveRole | null = null;
  if (playlist.ownerViewerId !== null && playlist.ownerViewerId === actor.viewerId) role = "owner";
  else if (memberRole !== null) role = memberRole;
  else if (playlist.visibility === "server") role = "viewer";
  if (role === null) return null;

  return isOrphaned(playlist) && RANK[role] > RANK.viewer ? "viewer" : role;
}

export interface PlaylistCapabilities {
  role: EffectiveRole | null;
  canView: boolean;
  canPlay: boolean;
  canCopy: boolean;
  canEditItems: boolean;
  canRename: boolean;
  canTransfer: boolean;
  canDelete: boolean;
  /** A member (not the owner) may remove their own share. */
  canLeave: boolean;
  canSetVisibility(next: PlaylistVisibility): boolean;
  canShare(roleToGrant: MemberRole, targetAccountId: string): boolean;
  canRevoke(row: MemberRowFacts): boolean;
}

export function capabilities(
  playlist: PlaylistFacts,
  actor: ActorFacts,
  memberRole: MemberRole | null
): PlaylistCapabilities {
  const role = effectiveRole(playlist, actor, memberRole);
  const orphaned = isOrphaned(playlist);
  const isOwner = role === "owner";
  const limited = actor.viewerRole === "limited";
  const adminMayDelete = actor.isServerMember && actor.isServerAdmin && !limited && playlist.visibility === "server";

  return {
    role,
    canView: role !== null,
    canPlay: role !== null,
    canCopy: role !== null,
    canEditItems: role === "owner" || role === "editor",
    canRename: role === "owner" || role === "editor",
    canTransfer: isOwner,
    canDelete: isOwner || adminMayDelete,
    canLeave: memberRole !== null && role !== null && !isOwner,
    canSetVisibility(next) {
      if (!isOwner) return false;
      // A limited profile may only take access away (public -> private), never grant it.
      return next === "server" ? !limited : true;
    },
    canShare(roleToGrant, targetAccountId) {
      if (orphaned || role === null) return false;
      if (limited && targetAccountId !== actor.accountId) return false;
      if (isOwner) return true;
      return role === "sharer" && roleToGrant === "viewer";
    },
    canRevoke(row) {
      if (orphaned || role === null) return false;
      if (isOwner) return true;
      return role === "sharer" && row.role === "viewer" && row.grantedByViewerId === actor.viewerId;
    },
  };
}
