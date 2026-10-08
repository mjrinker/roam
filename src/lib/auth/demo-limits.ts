/**
 * Playback limits for a public demo server. Its videos stream straight from the owner's Box account, and a
 * guest account is free to create, so a per-account limit alone means nothing: the real bound is a daily total
 * for the whole demo (what protects Box's quota and bandwidth), with a smaller per-account hourly limit as well.
 * Bytes themselves go from Box to the viewer and can't be counted here, so the cost of a play is bounded by
 * the size of the demo clips and the daily total.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

export const DEMO_PLAYS_PER_DAY = Number(process.env.DEMO_PLAYS_PER_DAY ?? 300);
export const DEMO_PLAYS_PER_ACCOUNT_PER_HOUR = 30;

export const DEMO_RESTING_MESSAGE = "The demo is resting for now: it has a daily limit on how much can be played. Come back tomorrow, or create your own server.";

/** Seconds until the demo's daily window renews (the limiter's windows are whole UTC days). */
export function secondsUntilWindowRenews(now = new Date()): number {
  return 86_400 - (Math.floor(now.getTime() / 1000) % 86_400);
}

export type DemoPlayCheck = { ok: true } | { ok: false; error: string };

/** Spends one play from the demo's budgets. Anything that isn't a demo server is always allowed and costs nothing. */
export async function checkDemoPlay(
  serverId: string,
  accountId: string,
  limits: { perDay?: number; perAccountPerHour?: number } = {}
): Promise<DemoPlayCheck> {
  const [server] = await db.select({ ownerId: servers.ownerId, isDemo: servers.isDemo }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server?.isDemo) return { ok: true };
  if (!(await checkRateLimit(accountId, "demo_play", limits.perAccountPerHour ?? DEMO_PLAYS_PER_ACCOUNT_PER_HOUR, 3600))) {
    return { ok: false, error: "That's a lot of plays for one hour. Try again a little later." };
  }
  // The limiter's table is keyed by an account, so the demo's total is recorded against its owner under a bucket named for the server.
  if (!(await checkRateLimit(server.ownerId, `demo_play:${serverId}`, limits.perDay ?? DEMO_PLAYS_PER_DAY, 86_400))) {
    return { ok: false, error: DEMO_RESTING_MESSAGE };
  }
  return { ok: true };
}
