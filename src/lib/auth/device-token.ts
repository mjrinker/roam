/**
 * Device tokens: how an app or device that can't use browser cookies (a TV app, a phone app, Kodi) stays signed in. A token is 32 random
 * bytes, shown once when its pairing is approved and kept only as a hash. It is sent as `Authorization: Bearer rdt_...` and counts as that
 * account's session (see getCurrentProfile and getCurrentViewer), as one chosen profile at a time.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { deviceTokens, viewers } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const TOKEN_PREFIX = "rdt_";
/** How often a token's "last used" time is rewritten (not on every request). */
export const TOUCH_EVERY_MS = 10 * 60 * 1000;
/** A token nobody has used for this long stops working. */
export const TOKEN_IDLE_LIFE_MS = 180 * 24 * 60 * 60 * 1000;

export const newToken = (): string => TOKEN_PREFIX + randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The token in an Authorization header ("Bearer rdt_..."), or null when it isn't one of ours in the right form. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(rdt_[A-Za-z0-9_-]{43})$/.exec((header ?? "").trim());
  return m ? m[1] : null;
}

/** A name for the device that is safe to show to whoever approves it. */
export function cleanLabel(raw: unknown, fallback = "Device"): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return s || fallback;
}

export type DeviceToken = typeof deviceTokens.$inferSelect;

/** Makes a token for an account (just signed in by an approved pairing). The profile is chosen afterwards, unless the account has only one. */
export async function createDeviceToken(ex: Db, args: { accountId: string; label: string; now?: Date }): Promise<{ token: string; row: DeviceToken }> {
  const token = newToken();
  const now = args.now ?? new Date();
  // With exactly one profile and no PIN there is nothing to choose.
  const profiles = await ex.select().from(viewers).where(eq(viewers.accountId, args.accountId));
  const only = profiles.length === 1 && !profiles[0].pinHash ? profiles[0] : null;
  const [row] = await ex
    .insert(deviceTokens)
    .values({ accountId: args.accountId, tokenHash: hashToken(token), label: cleanLabel(args.label), viewerId: only?.id ?? null, pinVersion: only?.pinVersion ?? 0, createdAt: now, lastUsedAt: now })
    .returning();
  return { token, row };
}

/** The live token row for a presented token, or null (unknown, revoked, or idle for too long). Rewrites "last used" now and then. */
export async function findDeviceToken(ex: Db, token: string, now = new Date()): Promise<DeviceToken | null> {
  const [row] = await ex.select().from(deviceTokens).where(and(eq(deviceTokens.tokenHash, hashToken(token)), isNull(deviceTokens.revokedAt))).limit(1);
  if (!row) return null;
  if (now.getTime() - row.lastUsedAt.getTime() > TOKEN_IDLE_LIFE_MS) return null;
  if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await ex.update(deviceTokens).set({ lastUsedAt: now }).where(eq(deviceTokens.id, row.id));
    return { ...row, lastUsedAt: now };
  }
  return row;
}

/** This account's devices, most recently used first (revoked ones left out). */
export async function listDeviceTokens(ex: Db, accountId: string): Promise<DeviceToken[]> {
  return ex.select().from(deviceTokens).where(and(eq(deviceTokens.accountId, accountId), isNull(deviceTokens.revokedAt))).orderBy(desc(deviceTokens.lastUsedAt));
}

/** Signs a device out. Scoped by account: someone else's device is simply not found. */
export async function revokeDeviceToken(ex: Db, accountId: string, id: string, now = new Date()): Promise<boolean> {
  const rows = await ex.update(deviceTokens).set({ revokedAt: now }).where(and(eq(deviceTokens.id, id), eq(deviceTokens.accountId, accountId), isNull(deviceTokens.revokedAt))).returning({ id: deviceTokens.id });
  return rows.length === 1;
}

/** Records which profile a device is using now (the caller has already checked the profile belongs to the account and its PIN). */
export async function setTokenProfile(ex: Db, tokenId: string, viewer: { id: string; pinVersion: number }): Promise<void> {
  await ex.update(deviceTokens).set({ viewerId: viewer.id, pinVersion: viewer.pinVersion }).where(eq(deviceTokens.id, tokenId));
}

/** Removes rows nobody will use again (revoked a month ago, or idle past their life). Run from the daily job. */
export async function purgeDeviceTokens(ex: Db, now = new Date()): Promise<number> {
  const rows = await ex
    .delete(deviceTokens)
    .where(or(lt(deviceTokens.revokedAt, new Date(now.getTime() - 30 * 24 * 3600_000)), lt(deviceTokens.lastUsedAt, new Date(now.getTime() - TOKEN_IDLE_LIFE_MS))))
    .returning({ id: deviceTokens.id });
  return rows.length;
}
