/** Push to Android (and Fire/Android TV) apps through Firebase Cloud Messaging. Does nothing unless FCM_SERVICE_ACCOUNT (the service account's JSON) is set. */
import { createSign } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { deviceTokens } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** The service account from the environment, or null when push to apps isn't set up (or the value is unusable). */
export function serviceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    return parsed.project_id && parsed.client_email && parsed.private_key ? (parsed as ServiceAccount) : null;
  } catch {
    return null;
  }
}

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** The signed request for an access token (Google's service-account flow): valid for an hour, allowed to send messages. */
export function signAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const audience = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: audience, iat: nowSeconds, exp: nowSeconds + 3600 })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(sa.private_key).toString("base64url")}`;
}

let cached: { token: string; until: number } | null = null;
export const resetAccessToken = () => {
  cached = null;
};

export async function accessToken(sa: ServiceAccount, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  if (cached && cached.until > now + 60_000) return cached.token;
  const res = await fetchImpl(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signAssertion(sa, Math.floor(now / 1000)) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  cached = { token: body.access_token, until: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

export interface FcmPayload {
  title: string;
  body: string;
  href: string | null;
}

/** Sends to every signed-in app of the account that allowed notifications. An app that has been uninstalled is forgotten; any other failure is ignored. */
export async function sendFcmTo(ex: Db, accountId: string, payload: FcmPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const sa = serviceAccount();
  if (!sa) return;
  const devices = await ex
    .select({ id: deviceTokens.id, pushToken: deviceTokens.pushToken })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.accountId, accountId), isNotNull(deviceTokens.pushToken), isNull(deviceTokens.revokedAt)));
  if (devices.length === 0) return;
  const bearer = await accessToken(sa, fetchImpl).catch(() => null);
  if (!bearer) return;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ message: { token: d.pushToken, notification: { title: payload.title, body: payload.body }, data: payload.href ? { href: payload.href } : {}, android: { priority: "NORMAL", ttl: "3600s" } } }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404 || res.status === 400) {
          const detail = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
          if (res.status === 404 || detail?.error?.status === "INVALID_ARGUMENT") await ex.update(deviceTokens).set({ pushToken: null }).where(eq(deviceTokens.id, d.id));
        }
      } catch {
        // a network failure: the notification is still in the app's list
      }
    })
  );
}

/** Remembers (or, with null, forgets) the Firebase registration of the device this token belongs to. */
export async function setPushToken(ex: Db, deviceTokenId: string, token: string | null): Promise<void> {
  await ex.update(deviceTokens).set({ pushToken: token }).where(eq(deviceTokens.id, deviceTokenId));
}
