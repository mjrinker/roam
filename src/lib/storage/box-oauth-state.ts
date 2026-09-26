import { randomBytes } from "node:crypto";
import { hmacState, verifyHmacState } from "@/lib/crypto";

/**
 * Signs/verifies the Box OAuth `state` param. Verifying the signature and
 * a short age window is necessary but not sufficient for CSRF safety —
 * the caller (api/box/callback) must ALSO re-check the payload's
 * profileId/serverId against the live session (current profile still
 * matches and still passes requireServerAdmin), rather than trusting this
 * payload alone. That defeats both classic OAuth-state CSRF and a
 * session-swap race (one user starts the flow, a different session
 * finishes it in the same browser).
 */

interface StatePayload {
  serverId: string;
  profileId: string;
  nonce: string;
  iat: number;
}

const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function signBoxOAuthState(serverId: string, profileId: string): string {
  const payload: StatePayload = {
    serverId,
    profileId,
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${hmacState(payloadB64)}`;
}

export function verifyBoxOAuthState(state: string): StatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  if (!verifyHmacState(payloadB64, signature)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.serverId !== "string" || typeof payload.profileId !== "string") {
    return null;
  }
  if (typeof payload.iat !== "number" || Date.now() - payload.iat > MAX_AGE_MS) {
    return null;
  }

  return payload;
}
