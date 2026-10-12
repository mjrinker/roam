/**
 * Google Drive has no per-file download links, only the account's own token, which must never reach a browser. So its streaming URL
 * points at Roam (/api/storage/stream/<token>), and the token says exactly one file on one connection, until a time, signed by the
 * server. Whoever holds it can read that one file for a few hours and nothing else, like the links the other providers hand out.
 */
import { hmacState, verifyHmacState } from "@/lib/crypto";

interface Payload {
  c: string; // connection id
  f: string; // the provider's file id
  e: number; // expiry, ms since the epoch
}

const TTL_MS = 4 * 60 * 60_000;

export function signStreamToken(connectionId: string, fileId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const payload: Payload = { c: connectionId, f: fileId, e: now + TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${b64}.${hmacState(b64)}`, expiresAt: new Date(payload.e) };
}

/** The connection and file a token names, or null when it is forged, malformed or expired. */
export function verifyStreamToken(token: string, now = Date.now()): { connectionId: string; fileId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  if (!verifyHmacState(parts[0], parts[1])) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<Payload>;
    if (typeof p.c !== "string" || typeof p.f !== "string" || typeof p.e !== "number" || p.e < now) return null;
    return { connectionId: p.c, fileId: p.f };
  } catch {
    return null;
  }
}

/** The address a player is given: absolute when the site's address is configured (a server may need to fetch it), else relative. */
export const streamUrl = (token: string, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string =>
  `${appUrl ? appUrl.replace(/\/+$/, "") : ""}/api/storage/stream/${token}`;
