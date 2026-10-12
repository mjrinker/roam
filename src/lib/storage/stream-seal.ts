/**
 * Seals what Roam's Cloudflare stream Worker needs for one Google Drive file (the file id and a short-lived Google access token) into a
 * string only the Worker can open: AES-256-GCM with a secret both hold (STREAM_SECRET, base64, 32 bytes). Roam puts it in the player's
 * link, so the token never reaches the browser in a form it can read. The layout is read by cloudflare/stream-worker.
 */
import { createCipheriv, randomBytes } from "node:crypto";

export interface StreamWorkerConfig {
  /** The Worker's address, no trailing slash. */
  url: string;
  /** base64 of 32 random bytes. */
  secret: string;
}

/** The Worker's settings when both are configured and usable, else null (Roam then streams through itself). */
export function streamWorkerConfig(env: Record<string, string | undefined> = process.env): StreamWorkerConfig | null {
  const url = env.STREAM_WORKER_URL?.trim().replace(/\/+$/, "");
  const secret = env.STREAM_SECRET?.trim();
  if (!url || !secret || !/^https:\/\//.test(url)) return null;
  if (Buffer.from(secret, "base64").length !== 32) return null;
  return { url, secret };
}

/** The link a player is given: the Worker's address plus the sealed file and token, good until `expiresAt`. */
export function sealedStreamUrl(config: StreamWorkerConfig, fileId: string, accessToken: string, expiresAt: Date): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.secret, "base64"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ f: fileId, t: accessToken, e: expiresAt.getTime() }), "utf8"), cipher.final()]);
  return `${config.url}/s/${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}
