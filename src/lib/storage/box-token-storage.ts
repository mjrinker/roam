import { BoxApiError, BoxClient, BoxOAuth, OAuthConfig } from "box-node-sdk";
import type { TokenStorage } from "box-node-sdk/box";
import type { AccessToken } from "box-node-sdk/schemas";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

/** A server's Box connection is dead (revoked or expired) and needs an admin to reconnect it. */
export class BoxReauthRequiredError extends Error {
  constructor(public readonly serverId: string) {
    super(`Server ${serverId}'s Box connection needs to be reconnected`);
    this.name = "BoxReauthRequiredError";
  }
}

/** Retries were exhausted under contention without confirming the token is actually dead. Transient — safe to retry later. */
export class BoxTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxTransientError";
  }
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Postgres-backed TokenStorage, one instance per server. Box rotates the
 * refresh token on every use and invalidates the old one immediately, so
 * store() always preserves the previous refresh token when a call doesn't
 * carry a new one (rather than nulling it out).
 */
export class DbTokenStorage implements TokenStorage {
  constructor(private readonly serverId: string) {}

  async get(): Promise<AccessToken | undefined> {
    const [server] = await db
      .select({
        boxAccessTokenEncrypted: servers.boxAccessTokenEncrypted,
        boxRefreshTokenEncrypted: servers.boxRefreshTokenEncrypted,
        boxTokenExpiresAt: servers.boxTokenExpiresAt,
      })
      .from(servers)
      .where(eq(servers.id, this.serverId))
      .limit(1);

    if (!server?.boxAccessTokenEncrypted || !server.boxRefreshTokenEncrypted) {
      return undefined;
    }

    // A decrypt failure (e.g. TOKEN_ENCRYPTION_KEY was rotated, orphaning
    // old ciphertext) is treated identically to an expired/revoked token —
    // surfaced as BoxReauthRequiredError by the caller, not a crash.
    let accessToken: string;
    let refreshToken: string;
    try {
      accessToken = decrypt(server.boxAccessTokenEncrypted);
      refreshToken = decrypt(server.boxRefreshTokenEncrypted);
    } catch {
      throw new BoxReauthRequiredError(this.serverId);
    }

    const expiresIn = server.boxTokenExpiresAt
      ? Math.max(0, Math.floor((server.boxTokenExpiresAt.getTime() - Date.now()) / 1000))
      : 0;

    return { accessToken, refreshToken, expiresIn, tokenType: "bearer" };
  }

  async store(token: AccessToken): Promise<undefined> {
    if (!token.accessToken) return undefined;

    let refreshTokenToStore = token.refreshToken;
    if (!refreshTokenToStore) {
      const [current] = await db
        .select({ boxRefreshTokenEncrypted: servers.boxRefreshTokenEncrypted })
        .from(servers)
        .where(eq(servers.id, this.serverId))
        .limit(1);
      if (current?.boxRefreshTokenEncrypted) {
        try {
          refreshTokenToStore = decrypt(current.boxRefreshTokenEncrypted);
        } catch {
          // Leave undefined — nothing usable to preserve.
        }
      }
    }

    const expiresAt = token.expiresIn
      ? new Date(Date.now() + token.expiresIn * 1000)
      : null;

    await db
      .update(servers)
      .set({
        boxAccessTokenEncrypted: encrypt(token.accessToken),
        boxRefreshTokenEncrypted: refreshTokenToStore ? encrypt(refreshTokenToStore) : null,
        boxTokenExpiresAt: expiresAt,
        boxAuthStatus: "connected",
      })
      .where(eq(servers.id, this.serverId));

    return undefined;
  }

  async clear(): Promise<undefined> {
    await db
      .update(servers)
      .set({
        boxAccessTokenEncrypted: null,
        boxRefreshTokenEncrypted: null,
        boxTokenExpiresAt: null,
        boxAuthStatus: "disconnected",
      })
      .where(eq(servers.id, this.serverId));
    return undefined;
  }
}

/**
 * Best-effort classification of "this failure means the stored token is
 * dead" vs. some other Box API error. A 401 on an ordinary API call always
 * counts; a 400 only counts if the body looks like an OAuth invalid_grant
 * response (Box's token endpoint uses standard OAuth2 error semantics).
 * Not exhaustively verified against live Box error responses — refine
 * this if real-world reauth detection turns out to miss/over-trigger.
 */
function isBoxAuthError(err: unknown): boolean {
  if (!(err instanceof BoxApiError)) return false;
  const status = err.responseInfo?.statusCode;
  if (status === 401) return true;
  if (status === 400) {
    const body = JSON.stringify(err.responseInfo?.body ?? "");
    return body.includes("invalid_grant") || body.includes("invalid_token");
  }
  return false;
}

const MAX_ATTEMPTS = 3;

/** Refresh when the stored access token has less than this left. */
const REFRESH_MARGIN_SECONDS = 120;

/**
 * The SDK only refreshes on a 401, but downscoping a token (what streaming
 * URLs and upload tokens do) answers an expired access token with a 400
 * "subject_token invalid", which never triggers that refresh — so when
 * nothing else has called Box in the last hour, every downscope fails until
 * something does. Call this before downscoping.
 */
export async function ensureFreshAccessToken(client: BoxClient): Promise<void> {
  const token = await client.auth.retrieveToken();
  if ((token.expiresIn ?? 0) < REFRESH_MARGIN_SECONDS) await client.auth.refreshToken();
}

/**
 * Runs `fn` against a Box client built fresh from this server's current
 * stored token. On an auth-shaped failure, retries with a freshly re-read
 * token (which may already hold a concurrent winner's rotated refresh
 * token — see the concurrency note in the project plan for why a lock
 * inside store() doesn't actually prevent this race).
 *
 * The retry-exhausted case is NOT automatically "reauth needed": if the
 * re-read token differs from what this attempt used, that was a stale
 * read (a race), not a dead token, and we retry again rather than give
 * up. Only when a compare-and-set confirms the token that just failed is
 * STILL what's stored do we flip boxAuthStatus and throw
 * BoxReauthRequiredError. This can loop under pathological contention, so
 * attempts are capped — if the cap is hit without either success or a
 * confirmed-dead token, throw BoxTransientError and leave boxAuthStatus
 * untouched, since there's no confirmed evidence the token is actually
 * dead, just unresolved contention.
 *
 * Do not "simplify" this by adding a lock around the whole operation
 * (holding a lock across an external network call to Box is its own
 * hazard in serverless — a crash mid-call could leave it held), by
 * throwing on the first auth failure without the CAS check, or by
 * dropping the attempt cap.
 */
export async function withBoxClient<T>(
  serverId: string,
  fn: (client: BoxClient) => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [before] = await db
      .select({ boxRefreshTokenEncrypted: servers.boxRefreshTokenEncrypted })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    const tokenStorage = new DbTokenStorage(serverId);
    const auth = new BoxOAuth({
      config: new OAuthConfig({
        clientId: getEnv("BOX_CLIENT_ID"),
        clientSecret: getEnv("BOX_CLIENT_SECRET"),
        tokenStorage,
      }),
    });
    const client = new BoxClient({ auth });

    try {
      return await fn(client);
    } catch (err) {
      lastError = err;
      if (!isBoxAuthError(err)) throw err;

      if (!before?.boxRefreshTokenEncrypted) {
        // Nothing was stored to begin with — genuinely not connected.
        throw new BoxReauthRequiredError(serverId);
      }

      const casResult = await db
        .update(servers)
        .set({ boxAuthStatus: "needs_reauth" })
        .where(
          and(
            eq(servers.id, serverId),
            eq(servers.boxRefreshTokenEncrypted, before.boxRefreshTokenEncrypted)
          )
        )
        .returning({ id: servers.id });

      if (casResult.length > 0) {
        throw new BoxReauthRequiredError(serverId);
      }
      // Else: the row changed since `before` was read — a concurrent
      // request already rotated the token. Loop and retry with it.
    }
  }

  throw new BoxTransientError(
    `Box API call for server ${serverId} failed after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
