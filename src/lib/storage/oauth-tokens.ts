/**
 * Keeping an OAuth connection's access token fresh, for providers that sign in with OAuth (Dropbox, OneDrive, Google Drive). Tokens live
 * encrypted on the storage_connections row. A provider supplies only how to trade a refresh token for new tokens; this handles when to,
 * the races between requests that do so at once, remembering the result, and what to do when the login is dead.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { storageConnections } from "@/lib/db/schema";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";

export interface OAuthTokens {
  accessToken: string;
  /** Absent when the provider keeps the same refresh token (Dropbox, Google); present when it rotates it (Microsoft). */
  refreshToken?: string | null;
  expiresInSeconds?: number | null;
  /** The permissions the provider says were granted (a space-separated list), when it says. Read when signing in, never on a refresh. */
  scope?: string | null;
}

/** The refresh token was refused as dead (revoked, expired, wrong): the one failure that means "sign in again". */
export class OAuthInvalidGrantError extends Error {
  constructor(message = "The refresh token was refused") {
    super(message);
    this.name = "OAuthInvalidGrantError";
  }
}

export type Refresher = (refreshToken: string) => Promise<OAuthTokens>;

/** Refresh when less than this is left. */
const MARGIN_MS = 120_000;
const inFlight = new Map<string, Promise<string>>();

/** Stores a fresh set of tokens for a connection (after sign-in, or a refresh) and marks it connected. */
export async function saveTokens(connectionId: string, tokens: OAuthTokens, accountName?: string | null, access?: { writeGranted: boolean }): Promise<void> {
  const [current] = await db.select({ refresh: storageConnections.refreshTokenEncrypted }).from(storageConnections).where(eq(storageConnections.id, connectionId)).limit(1);
  const refreshToken = tokens.refreshToken ?? (current?.refresh ? safeDecrypt(current.refresh) : null);
  await db
    .update(storageConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.accessToken),
      refreshTokenEncrypted: refreshToken ? encrypt(refreshToken) : null,
      tokenExpiresAt: tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000) : null,
      authStatus: "connected",
      ...(accountName ? { accountName } : {}),
      // A new sign-in decides what Roam may do from then on: one without the write permission turns editing off.
      ...(access ? { writeGranted: access.writeGranted, ...(access.writeGranted ? {} : { writeEnabled: false }) } : {}),
    })
    .where(eq(storageConnections.id, connectionId));
}

function safeDecrypt(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/**
 * A usable access token for the connection. `force` refreshes even if the stored one looks valid (the provider just said 401).
 * Throws StorageReauthRequiredError when the connection has no login, or its refresh token is dead.
 */
export function accessTokenFor(connectionId: string, refresher: Refresher, force = false): Promise<string> {
  // Concurrent callers in this process share one refresh (some providers rotate the refresh token, so two at once would fight).
  const key = `${connectionId}:${force}`;
  let run = inFlight.get(key);
  if (!run) {
    run = obtain(connectionId, refresher, force).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
  }
  return run;
}

async function obtain(connectionId: string, refresher: Refresher, force: boolean): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({ access: storageConnections.accessTokenEncrypted, refresh: storageConnections.refreshTokenEncrypted, expires: storageConnections.tokenExpiresAt })
      .from(storageConnections)
      .where(eq(storageConnections.id, connectionId))
      .limit(1);
    if (!row?.refresh) throw new StorageReauthRequiredError(connectionId);
    const access = row.access ? safeDecrypt(row.access) : null;
    const refreshToken = safeDecrypt(row.refresh);
    // Ciphertext that can't be read (the encryption key changed) is the same as a dead login.
    if (!refreshToken) throw new StorageReauthRequiredError(connectionId);
    if (!force && access && row.expires && row.expires.getTime() - Date.now() > MARGIN_MS) return access;

    try {
      const tokens = await refresher(refreshToken);
      await saveTokens(connectionId, tokens);
      return tokens.accessToken;
    } catch (err) {
      if (!(err instanceof OAuthInvalidGrantError)) throw err;
      // Mark it dead only if the token that just failed is still the stored one; otherwise a concurrent request already got a new one.
      const marked = await db
        .update(storageConnections)
        .set({ authStatus: "needs_reauth" })
        .where(and(eq(storageConnections.id, connectionId), eq(storageConnections.refreshTokenEncrypted, row.refresh)))
        .returning({ id: storageConnections.id });
      if (marked.length > 0) throw new StorageReauthRequiredError(connectionId);
      force = false;
    }
  }
  throw new StorageReauthRequiredError(connectionId);
}

/**
 * An access token with at least `minMs` of life left, and when it ends (a link that carries the token can't outlive it). Refreshes if
 * the stored one is closer to its end than that.
 */
export async function accessTokenValidFor(connectionId: string, refresher: Refresher, minMs: number): Promise<{ token: string; expiresAt: Date }> {
  const expiry = async () => (await db.select({ at: storageConnections.tokenExpiresAt }).from(storageConnections).where(eq(storageConnections.id, connectionId)).limit(1))[0]?.at ?? null;
  let token = await accessTokenFor(connectionId, refresher);
  let at = await expiry();
  if (!at || at.getTime() - Date.now() < minMs) {
    token = await accessTokenFor(connectionId, refresher, true);
    at = await expiry();
  }
  return { token, expiresAt: at ?? new Date(Date.now() + 50 * 60_000) };
}
