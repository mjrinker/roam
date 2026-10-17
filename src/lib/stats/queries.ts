/**
 * The server admin's watch statistics, from watch_activity: totals by day, the most watched titles, and each household's time. Households are
 * accounts; nothing here knows which profile of a household it was. Admin-only: the pages that call this require the server's admin.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { titles, watchActivity } from "@/lib/db/schema";
import { householdNames } from "@/lib/ownership/owners";
import { dayOf } from "@/lib/stats/record";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The ranges offered, in days. */
export const RANGES = [7, 30, 90, 365] as const;
export type RangeDays = (typeof RANGES)[number];
export const parseRange = (raw: unknown): RangeDays => (RANGES as readonly number[]).includes(Number(raw)) ? (Number(raw) as RangeDays) : 30;

/** The first day of a range ending today (inclusive), as 2026-10-17. */
export function sinceDay(days: number, now = new Date()): string {
  return dayOf(new Date(now.getTime() - (days - 1) * 86_400_000));
}

/** Every day from `since` through `today`, with 0 for days nothing was recorded. */
export function fillDays(rows: readonly { day: string; seconds: number }[], days: number, now = new Date()): { day: string; seconds: number }[] {
  const have = new Map(rows.map((r) => [r.day, r.seconds]));
  return Array.from({ length: days }, (_, i) => {
    const day = dayOf(new Date(now.getTime() - (days - 1 - i) * 86_400_000));
    return { day, seconds: have.get(day) ?? 0 };
  });
}

export interface TopTitle {
  id: string;
  name: string;
  kind: string;
  seconds: number;
  /** How many households watched it (a count, never who). */
  households: number;
}

export interface Overview {
  days: number;
  totalSeconds: number;
  /** Movies and shows; and audiobooks. */
  watchSeconds: number;
  listenSeconds: number;
  activeHouseholds: number;
  titles: number;
  byDay: { day: string; seconds: number }[];
  top: TopTitle[];
}

export async function overview(ex: Db, args: { serverId: string; days: number; limit?: number; now?: Date }): Promise<Overview> {
  const since = sinceDay(args.days, args.now);
  const inRange = and(eq(watchActivity.serverId, args.serverId), gte(watchActivity.day, since));
  const [totals] = await ex
    .select({
      total: sql<number>`coalesce(sum(${watchActivity.seconds}), 0)::int`,
      listen: sql<number>`coalesce(sum(${watchActivity.seconds}) FILTER (WHERE ${titles.kind} = 'audiobook'), 0)::int`,
      households: sql<number>`count(DISTINCT ${watchActivity.accountId})::int`,
      titles: sql<number>`count(DISTINCT ${watchActivity.titleId})::int`,
    })
    .from(watchActivity)
    .innerJoin(titles, eq(titles.id, watchActivity.titleId))
    .where(inRange);
  const days = await ex
    .select({ day: sql<string>`${watchActivity.day}::text`, seconds: sql<number>`sum(${watchActivity.seconds})::int` })
    .from(watchActivity)
    .where(inRange)
    .groupBy(watchActivity.day);
  const top = await ex
    .select({ id: titles.id, name: titles.name, kind: titles.kind, seconds: sql<number>`sum(${watchActivity.seconds})::int`, households: sql<number>`count(DISTINCT ${watchActivity.accountId})::int` })
    .from(watchActivity)
    .innerJoin(titles, eq(titles.id, watchActivity.titleId))
    .where(inRange)
    .groupBy(titles.id)
    .orderBy(desc(sql`sum(${watchActivity.seconds})`), titles.name)
    .limit(args.limit ?? 10);
  return {
    days: args.days,
    totalSeconds: totals.total,
    watchSeconds: totals.total - totals.listen,
    listenSeconds: totals.listen,
    activeHouseholds: totals.households,
    titles: totals.titles,
    byDay: fillDays(days, args.days, args.now),
    top,
  };
}

export interface HouseholdRow {
  accountId: string;
  name: string;
  seconds: number;
  titles: number;
  /** The last day anything was recorded in the range. */
  lastDay: string | null;
}

/** Every household of the server with its time in the range (those with none included, last), the most first. */
export async function households(ex: Db, args: { serverId: string; days: number; members: { accountId: string }[]; now?: Date }): Promise<HouseholdRow[]> {
  const rows = await ex
    .select({ accountId: watchActivity.accountId, seconds: sql<number>`sum(${watchActivity.seconds})::int`, titles: sql<number>`count(DISTINCT ${watchActivity.titleId})::int`, lastDay: sql<string>`max(${watchActivity.day})::text` })
    .from(watchActivity)
    .where(and(eq(watchActivity.serverId, args.serverId), gte(watchActivity.day, sinceDay(args.days, args.now))))
    .groupBy(watchActivity.accountId);
  const names = await householdNames(ex, args.members.map((m) => m.accountId), true);
  const by = new Map(rows.map((r) => [r.accountId, r]));
  return args.members
    .map((m) => ({ accountId: m.accountId, name: names.get(m.accountId) ?? "A household", seconds: by.get(m.accountId)?.seconds ?? 0, titles: by.get(m.accountId)?.titles ?? 0, lastDay: by.get(m.accountId)?.lastDay ?? null }))
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

export interface HouseholdDetail {
  name: string;
  totalSeconds: number;
  byDay: { day: string; seconds: number }[];
  top: { id: string; name: string; kind: string; seconds: number; lastDay: string }[];
}

/** What one household watched in the range (null when it isn't a member of the server). */
export async function householdDetail(ex: Db, args: { serverId: string; accountId: string; days: number; isMember: boolean; limit?: number; now?: Date }): Promise<HouseholdDetail | null> {
  if (!args.isMember) return null;
  const mine = and(eq(watchActivity.serverId, args.serverId), eq(watchActivity.accountId, args.accountId), gte(watchActivity.day, sinceDay(args.days, args.now)));
  const days = await ex.select({ day: sql<string>`${watchActivity.day}::text`, seconds: sql<number>`sum(${watchActivity.seconds})::int` }).from(watchActivity).where(mine).groupBy(watchActivity.day);
  const top = await ex
    .select({ id: titles.id, name: titles.name, kind: titles.kind, seconds: sql<number>`sum(${watchActivity.seconds})::int`, lastDay: sql<string>`max(${watchActivity.day})::text` })
    .from(watchActivity)
    .innerJoin(titles, eq(titles.id, watchActivity.titleId))
    .where(mine)
    .groupBy(titles.id)
    .orderBy(desc(sql`sum(${watchActivity.seconds})`), titles.name)
    .limit(args.limit ?? 25);
  const name = (await householdNames(ex, [args.accountId], true)).get(args.accountId) ?? "A household";
  return { name, totalSeconds: days.reduce((n, d) => n + d.seconds, 0), byDay: fillDays(days, args.days, args.now), top };
}

/** "3h 20m", "45m", "0m". */
export function formatHours(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
