import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { screenTime } from "@/lib/db/schema";
import { evaluateScreenTime, hasScreenTimeRules, localClock, stopInSeconds, type ScreenTimeDecision, type ScreenTimeSettings } from "./rules";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const settingsOf = (v: { screenTimeMinutes: number | null; quietFrom: number | null; quietTo: number | null; timeZone: string | null }): ScreenTimeSettings => ({ limitMinutes: v.screenTimeMinutes, quietFrom: v.quietFrom, quietTo: v.quietTo, timeZone: v.timeZone });

export async function usedToday(ex: Db, viewerId: string, settings: ScreenTimeSettings, now: Date): Promise<number> {
  const day = localClock(now, settings.timeZone).day;
  const [row] = await ex.select({ seconds: screenTime.seconds }).from(screenTime).where(and(eq(screenTime.viewerId, viewerId), eq(screenTime.day, day))).limit(1);
  return row?.seconds ?? 0;
}

/** Adds time watched to today's total (a few seconds at a time, as progress is saved). Nothing is recorded for a profile with no rules. */
export async function addWatched(ex: Db, viewerId: string, settings: ScreenTimeSettings, seconds: number, now: Date): Promise<void> {
  if (!hasScreenTimeRules(settings) || !(seconds > 0)) return;
  const day = localClock(now, settings.timeZone).day;
  await ex
    .insert(screenTime)
    .values({ viewerId, day, seconds: Math.round(seconds) })
    .onConflictDoUpdate({ target: [screenTime.viewerId, screenTime.day], set: { seconds: sql`${screenTime.seconds} + ${Math.round(seconds)}` } });
}

/** The decision for a profile right now (allowed with what is left, or refused and why); null for a profile with no rules. */
export async function screenTimeNow(ex: Db, viewer: { id: string; screenTimeMinutes: number | null; quietFrom: number | null; quietTo: number | null; timeZone: string | null }, now: Date = new Date()): Promise<{ decision: ScreenTimeDecision; stopInSeconds: number | null } | null> {
  const settings = settingsOf(viewer);
  if (!hasScreenTimeRules(settings)) return null;
  const decision = evaluateScreenTime(settings, await usedToday(ex, viewer.id, settings, now), now);
  return { decision, stopInSeconds: decision.allowed ? stopInSeconds(decision) : 0 };
}

