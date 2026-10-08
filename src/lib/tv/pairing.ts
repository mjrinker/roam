/**
 * Signing a TV in without a keyboard (see tv_pairings in the schema). The TV starts a pairing and shows the short code; the person
 * approves that code from a device where they are signed in; the TV, polling with a secret only it holds, receives a session once.
 *
 * Choices that matter for safety: codes come from an alphabet without look-alike characters (and from the system random number
 * generator); they live ten minutes and work once; the secret is stored only as a hash; approving is limited per account and
 * starting is limited per address; and nothing about a code's existence is revealed to someone who merely guesses.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { tvPairings } from "@/lib/db/schema";
import { hmacSign } from "@/lib/crypto";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I or L
export const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_STARTS_PER_ADDRESS_PER_HOUR = 20;
export const MAX_PENDING = 5000;

export function generateUserCode(rand: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return code;
}

/** "ABCDEFGH" as shown to people: "ABCD-EFGH". */
export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What someone typed, as a code, or null if it can't be one (wrong length or characters). Spaces, hyphens and case are ignored. */
export function normalizeUserCode(input: string | null | undefined): string | null {
  const code = (input ?? "").toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

export const newDeviceSecret = (): string => randomBytes(32).toString("base64url");
export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");
/** The address kept only as a keyed hash. */
export const addressKey = (ip: string): string => hmacSign("roam-tv-address", ip || "unknown");

/** A plain-words label for a TV from its browser identification, shown when someone approves its code. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (/Tizen/i.test(ua)) return "Samsung TV";
  if (/Web0S|webOS/i.test(ua)) return "LG TV";
  if (/AFT[A-Z0-9]|Silk|FireTV/i.test(ua)) return "Fire TV";
  if (/VIZIO|SmartCast/i.test(ua)) return "Vizio TV";
  if (/SMART-TV|SmartTV|HbbTV/i.test(ua)) return "Smart TV";
  return "TV";
}

export type StartResult = { ok: true; userCode: string; secret: string; expiresAt: Date } | { ok: false; reason: "too_many" | "busy" };

export async function startPairing(ex: Db, args: { ip: string; userAgent: string | null; now?: Date }): Promise<StartResult> {
  const now = args.now ?? new Date();
  const ipHash = addressKey(args.ip);
  // Old rows are not worth keeping: an hour past their life they go.
  await ex.delete(tvPairings).where(lt(tvPairings.expiresAt, new Date(now.getTime() - 60 * 60 * 1000)));

  const [{ n: recent }] = await ex.select({ n: count() }).from(tvPairings).where(and(eq(tvPairings.ipHash, ipHash), gt(tvPairings.createdAt, new Date(now.getTime() - 60 * 60 * 1000))));
  if (recent >= MAX_STARTS_PER_ADDRESS_PER_HOUR) return { ok: false, reason: "too_many" };
  const [{ n: pending }] = await ex.select({ n: count() }).from(tvPairings).where(and(eq(tvPairings.status, "pending"), gt(tvPairings.expiresAt, now)));
  if (pending >= MAX_PENDING) return { ok: false, reason: "busy" };

  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const secret = newDeviceSecret();
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const inserted = await ex
      .insert(tvPairings)
      .values({ userCode, deviceHash: hashSecret(secret), deviceLabel: deviceLabel(args.userAgent), ipHash, expiresAt, createdAt: now })
      .onConflictDoNothing({ target: tvPairings.userCode })
      .returning({ userCode: tvPairings.userCode });
    if (inserted.length > 0) return { ok: true, userCode, secret, expiresAt };
  }
  return { ok: false, reason: "busy" };
}

/** A still-open pairing for a typed code (so the approver can be shown what they are approving), or null. */
export async function findOpenPairing(ex: Db, userCode: string, now = new Date()) {
  const [row] = await ex
    .select({ id: tvPairings.id, deviceLabel: tvPairings.deviceLabel, createdAt: tvPairings.createdAt, expiresAt: tvPairings.expiresAt })
    .from(tvPairings)
    .where(and(eq(tvPairings.userCode, userCode), eq(tvPairings.status, "pending"), gt(tvPairings.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** The code a TV was given, if its pairing is still open (a reloaded pairing screen keeps its code instead of spending another). */
export async function openCodeForSecret(ex: Db, secret: string, now = new Date()): Promise<string | null> {
  const [row] = await ex
    .select({ userCode: tvPairings.userCode })
    .from(tvPairings)
    .where(and(eq(tvPairings.deviceHash, hashSecret(secret)), eq(tvPairings.status, "pending"), gt(tvPairings.expiresAt, now)))
    .limit(1);
  return row?.userCode ?? null;
}

/** Approves a still-open pairing for this account. False when there is no such open pairing (a wrong, expired or already-used code look the same). */
export async function approvePairing(ex: Db, args: { userCode: string; accountId: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const rows = await ex
    .update(tvPairings)
    .set({ status: "approved", accountId: args.accountId })
    .where(and(eq(tvPairings.userCode, args.userCode), eq(tvPairings.status, "pending"), gt(tvPairings.expiresAt, now)))
    .returning({ id: tvPairings.id });
  return rows.length === 1;
}

export type PollResult = { status: "pending" } | { status: "expired" } | { status: "approved"; accountId: string };

/** What the TV learns when it asks. An approved pairing is handed over exactly once: the claim is one conditional update. */
export async function pollPairing(ex: Db, secret: string, now = new Date()): Promise<PollResult> {
  const deviceHash = hashSecret(secret);
  const claimed = await ex
    .update(tvPairings)
    .set({ status: "consumed" })
    .where(and(eq(tvPairings.deviceHash, deviceHash), eq(tvPairings.status, "approved"), gt(tvPairings.expiresAt, now)))
    .returning({ accountId: tvPairings.accountId });
  if (claimed.length === 1 && claimed[0].accountId) return { status: "approved", accountId: claimed[0].accountId };

  const [row] = await ex.select({ status: tvPairings.status, expiresAt: tvPairings.expiresAt }).from(tvPairings).where(eq(tvPairings.deviceHash, deviceHash)).limit(1);
  if (row && row.status === "pending" && row.expiresAt > now) return { status: "pending" };
  return { status: "expired" };
}

/** Counts used by tests and monitoring. */
export const openPairingCount = async (ex: Db, now = new Date()): Promise<number> =>
  (await ex.select({ n: sql<number>`count(*)::int` }).from(tvPairings).where(and(eq(tvPairings.status, "pending"), gt(tvPairings.expiresAt, now))))[0].n;
