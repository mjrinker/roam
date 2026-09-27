import { hmacSign, hmacVerify } from "@/lib/crypto";

/**
 * The cookie that remembers which profile is selected on this device:
 * `<viewerId>.<expiry seconds>.<signature>`. The signature covers the account
 * and the profile's pinVersion, so a cookie can't be replayed on another
 * account, and setting/changing/clearing a PIN invalidates every existing
 * selection of that profile. It is verified against the database on every
 * request; the signature only proves the server issued it.
 */

export const VIEWER_COOKIE = "roam_viewer";
export const VIEWER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const INFO = "roam-viewer-cookie";

export interface ViewerCookieClaims {
  viewerId: string;
  accountId: string;
  pinVersion: number;
}

const payloadFor = (c: ViewerCookieClaims, expiry: number) =>
  `${c.accountId}|${c.viewerId}|${c.pinVersion}|${expiry}`;

export function signViewerCookie(claims: ViewerCookieClaims, nowMs = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + VIEWER_COOKIE_MAX_AGE_SECONDS;
  return `${claims.viewerId}.${expiry}.${hmacSign(INFO, payloadFor(claims, expiry))}`;
}

/** The viewer id a cookie value names (unverified; used to look the row up). */
export function viewerIdFromCookie(value: string): string | null {
  const parts = value.split(".");
  return parts.length === 3 && /^[0-9a-f-]{36}$/i.test(parts[0]) ? parts[0] : null;
}

/** True only for a well-formed, unexpired cookie whose signature matches these claims. */
export function verifyViewerCookie(value: string, claims: ViewerCookieClaims, nowMs = Date.now()): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== claims.viewerId) return false;
  const expiry = Number(parts[1]);
  if (!Number.isInteger(expiry) || expiry * 1000 < nowMs) return false;
  return hmacVerify(INFO, payloadFor(claims, expiry), parts[2]);
}
