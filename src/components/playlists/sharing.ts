/** Pure rules the share dialog shows, kept apart from the component so they can be tested. */

export type ShareRole = "viewer" | "sharer" | "editor";

export const ROLE_INFO: Record<ShareRole, { label: string; hint: string }> = {
  viewer: { label: "Viewer", hint: "Can watch it and make their own copy." },
  sharer: { label: "Sharer", hint: "Can also share it with others as a viewer." },
  editor: { label: "Editor", hint: "Can also add, remove and reorder items, and rename it." },
};

/** What the playlist detail says this profile may do about sharing. */
export interface ShareCaps {
  share: boolean;
  grantRoles: ShareRole[];
  manageMembers: boolean;
  makePublic: boolean;
  makePrivate: boolean;
}

export interface ShareRow {
  id: string;
  role: ShareRole;
  isMe: boolean;
  grantedByMe: boolean;
}

/** Show the Share button at all? */
export function showShareButton(caps: ShareCaps): boolean {
  return caps.share || caps.manageMembers || caps.makePublic || caps.makePrivate;
}

/** The owner removes anyone; a sharer only the viewer shares it granted itself. (Leaving your own share is the Leave button.) */
export function canRemoveShare(caps: ShareCaps, row: ShareRow): boolean {
  if (row.isMe) return false;
  if (caps.manageMembers) return true;
  return caps.grantRoles.length > 0 && row.role === "viewer" && row.grantedByMe;
}

/** Only the owner changes a role. */
export function canChangeRole(caps: ShareCaps, row: ShareRow): boolean {
  return caps.manageMembers && !row.isMe;
}

/** Profiles worth offering: not already shared with, not the owner, matching the search text. */
export function pickCandidates<T extends { id: string; name: string }>(
  loaded: readonly T[],
  sharedIds: ReadonlySet<string>,
  ownerId: string | null,
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  return loaded.filter((v) => v.id !== ownerId && !sharedIds.has(v.id) && (q === "" || v.name.toLowerCase().includes(q)));
}

/** The role a new share starts with: the weakest the actor may grant. */
export function defaultRole(grantRoles: readonly ShareRole[]): ShareRole {
  return grantRoles.includes("viewer") ? "viewer" : (grantRoles[0] ?? "viewer");
}
