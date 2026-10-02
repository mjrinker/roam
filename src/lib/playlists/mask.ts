/**
 * A profile that hides itself on the server (`visibleOnServer` off) shows to
 * readers from OTHER accounts as a generic "Profile"; its own account still
 * sees it normally.
 */
export const GENERIC_PROFILE_NAME = "Profile";
export const GENERIC_AVATAR_KEY = "teal-user";

export interface MaskableViewer {
  id: string;
  name: string;
  avatarKey: string;
  visibleOnServer: boolean;
  accountId: string;
}

export interface PublicViewer {
  id: string;
  name: string;
  avatarKey: string;
}

export function maskViewer(v: MaskableViewer, readerAccountId: string): PublicViewer {
  if (v.visibleOnServer || v.accountId === readerAccountId) return { id: v.id, name: v.name, avatarKey: v.avatarKey };
  return { id: v.id, name: GENERIC_PROFILE_NAME, avatarKey: GENERIC_AVATAR_KEY };
}
