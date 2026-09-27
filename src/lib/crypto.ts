import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM encryption for Box OAuth tokens at rest (see servers.
 * boxAccessTokenEncrypted / boxRefreshTokenEncrypted), plus an HMAC key
 * derived from the same secret for signing the Box OAuth `state` param —
 * domain-separated via HKDF `info` so one secret safely serves both
 * purposes without needing a second one.
 *
 * TOKEN_ENCRYPTION_KEY: a raw 32-byte AES-256 key, base64-encoded.
 * Generate with `openssl rand -base64 32`. Rotating this key orphans every
 * server's stored Box tokens (they become undecryptable) — every server
 * would need reconnecting. A decrypt() failure is treated the same as an
 * expired/revoked Box token by callers (see lib/storage/box-token-storage.ts),
 * not as a crash.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // standard GCM nonce size

let cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) — generate with \`openssl rand -base64 32\``
    );
  }
  cachedKey = key;
  return cachedKey;
}

/** Encrypts a string, returning `base64(iv).base64(authTag).base64(ciphertext)`. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext]
    .map((buf) => buf.toString("base64"))
    .join(".");
}

/**
 * Decrypts a value produced by `encrypt`. Throws on any failure (wrong
 * key, tampered/corrupted data, wrong format) — callers dealing with Box
 * tokens should treat that identically to an expired/revoked token, not
 * let it crash the request.
 */
export function decrypt(packed: string): string {
  const parts = packed.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted value");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * A key derived from TOKEN_ENCRYPTION_KEY via HKDF, domain-separated from
 * the raw encryption key by `info`, used to HMAC-sign the Box OAuth
 * `state` param (see lib/storage/box-oauth-state.ts). Never used for
 * AES — a distinct derived key for a distinct purpose.
 */
function deriveKey(info: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    getKey(),
    Buffer.alloc(0), // no salt — the input key material is already a high-entropy secret
    info,
    32
  );
  return Buffer.from(derived);
}

/** HMAC-SHA256 (base64url) under a key derived for `info`, so each purpose gets its own key. */
export function hmacSign(info: string, payload: string): string {
  return createHmac("sha256", deriveKey(info)).update(payload).digest("base64url");
}

export function hmacVerify(info: string, payload: string, signature: string): boolean {
  const expectedBuf = Buffer.from(hmacSign(info, payload));
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function hmacState(payload: string): string {
  return hmacSign("box-oauth-state", payload);
}

export function verifyHmacState(payload: string, signature: string): boolean {
  return hmacVerify("box-oauth-state", payload, signature);
}
