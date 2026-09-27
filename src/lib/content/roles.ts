/**
 * Who may change what about a profile. Independent of the rating limit
 * itself (see lib/content/access) — a profile's role decides who can EDIT
 * settings, not what content that profile can see.
 *
 *   owner   — created with the account (see ensureDefaultViewer); manages
 *             every profile, including creating/deleting them and assigning
 *             the other two roles. Exactly one per account, and it can't be
 *             deleted or reassigned.
 *   admin   — manages its own settings (name, avatar, locale, rating limit,
 *             PIN) but no one else's, and can't create or delete profiles.
 *   limited — can only rename itself or change its own avatar; everything
 *             else needs the owner.
 */

import type { ViewerRole } from "@/lib/db/schema";

export interface RoleActor {
  role: ViewerRole;
}

/** May create, delete, or edit any field of any OTHER profile, and assign roles. */
export function canManageAccount(actor: RoleActor): boolean {
  return actor.role === "owner";
}

/** May change its OWN language, rating limit, or PIN (not just name/avatar). */
export function canSelfManage(actor: RoleActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

/** Whether `actor` may make an extended edit (locale/maxAge/allowUnrated/pin/role) to `targetId`. */
export function canEditExtended(actor: RoleActor & { id: string }, targetId: string): boolean {
  if (canManageAccount(actor)) return true;
  return actor.id === targetId && canSelfManage(actor);
}

/** Whether `actor` may touch `targetId` at all (even just name/avatar). */
export function canEditProfile(actor: RoleActor & { id: string }, targetId: string): boolean {
  return canManageAccount(actor) || actor.id === targetId;
}
