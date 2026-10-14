/**
 * The Does the Dog Die API (https://www.doesthedogdie.com/api, governed by its API Terms of Service), asked with the deployment's own key
 * (DDD_API_KEY: never a server admin's, and never sent to a browser). Every request is counted against the free tier's monthly allowance,
 * so Roam keeps its own tally from the rate-limit headers and stops asking before the allowance is gone.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { platformJobs } from "@/lib/db/schema";

const BASE = "https://www.doesthedogdie.com/api/v3";
/** Past this share of the month's allowance used, Roam stops asking until the month turns over (the rest is for people already waiting). */
export const BUDGET_USED_FRACTION = 0.9;
const USAGE_JOB = "ddd-usage";

export const dddKey = (): string | null => process.env.DDD_API_KEY?.trim() || null;
export const dddConfigured = (): boolean => dddKey() !== null;

export type DddFailure = "budget" | "rate" | "monthly" | "auth" | "timeout" | "error";
export class DddError extends Error {
  constructor(readonly reason: DddFailure, message: string) {
    super(message);
  }
}

export interface DddUsage {
  limitMonth: number | null;
  remainingMonth: number | null;
  limitMinute: number | null;
  remainingMinute: number | null;
  at: string;
  /** Set when they said the month's allowance is gone: no request until this moment. */
  blockedUntil?: string;
}

let usageMemo: { at: number; usage: DddUsage | null } | null = null;
let pausedUntilMs = 0;

/** The latest numbers from their rate-limit headers (shown on the platform page); null before the first request. */
export async function readUsage(now = Date.now()): Promise<DddUsage | null> {
  if (usageMemo && now - usageMemo.at < 30_000) return usageMemo.usage;
  const [row] = await db.select().from(platformJobs).where(eq(platformJobs.name, USAGE_JOB)).limit(1);
  const usage = (row?.summary as unknown as DddUsage | undefined) ?? null;
  usageMemo = { at: now, usage };
  return usage;
}

async function writeUsage(usage: DddUsage): Promise<void> {
  usageMemo = { at: Date.now(), usage };
  await db
    .insert(platformJobs)
    .values({ name: USAGE_JOB, lastRunAt: new Date(), summary: { ...usage } })
    .onConflictDoUpdate({ target: platformJobs.name, set: { lastRunAt: new Date(), summary: { ...usage } } });
}

/** Whether their monthly allowance is gone and Roam is waiting for the month to turn over. */
export const isBlocked = (usage: DddUsage | null, now = Date.now()): boolean => !!usage?.blockedUntil && now < Date.parse(usage.blockedUntil);

const num = (v: string | null) => (v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Whether a request may be made right now: not paused after a per-minute limit, not blocked for the month, and (when `budget` is asked
 * for, at the start of a title) under the budget. A title already begun is finished even if the budget is crossed on the way.
 */
export async function mayAsk(opts: { budget?: boolean } = {}, now = Date.now()): Promise<DddFailure | null> {
  if (now < pausedUntilMs) return "rate";
  const usage = await readUsage(now);
  if (!usage) return null;
  if (usage.blockedUntil && now < Date.parse(usage.blockedUntil)) return "monthly";
  if (opts.budget && usage.limitMonth && usage.remainingMonth !== null && usage.remainingMonth <= usage.limitMonth * (1 - BUDGET_USED_FRACTION)) return "budget";
  return null;
}

const startOfNextMonthUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

async function get<T>(path: string, timeoutMs: number): Promise<T | null> {
  const key = dddKey();
  if (!key) throw new DddError("auth", "No Does the Dog Die key is set.");
  const blocked = await mayAsk();
  if (blocked) throw new DddError(blocked, `Not asking Does the Dog Die right now (${blocked}).`);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { "X-API-KEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(Math.max(200, timeoutMs)), cache: "no-store" });
  } catch (err) {
    throw new DddError((err as Error).name === "TimeoutError" ? "timeout" : "error", `Does the Dog Die request failed: ${(err as Error).message}`);
  }
  const h = res.headers;
  const usage: DddUsage = {
    limitMonth: num(h.get("x-ratelimit-limit-month")),
    remainingMonth: num(h.get("x-ratelimit-remaining-month")),
    limitMinute: num(h.get("x-ratelimit-limit-minute")),
    remainingMinute: num(h.get("x-ratelimit-remaining-minute")),
    at: new Date().toISOString(),
  };
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "monthly_limit_exceeded") {
      await writeUsage({ ...usage, remainingMonth: 0, blockedUntil: startOfNextMonthUtc(new Date()).toISOString() }).catch(() => undefined);
      throw new DddError("monthly", "Does the Dog Die's monthly allowance is used up.");
    }
    pausedUntilMs = Date.now() + Math.min(60, Math.max(1, num(h.get("retry-after")) ?? 30)) * 1000;
    throw new DddError("rate", "Does the Dog Die asked us to slow down.");
  }
  if (res.status === 401 || res.status === 403) throw new DddError("auth", `Does the Dog Die refused the key (${res.status}).`);
  if (usage.limitMonth !== null) await writeUsage(usage).catch(() => undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new DddError("error", `Does the Dog Die answered ${res.status}.`);
  return (await res.json()) as T;
}

export interface DddItemSummary {
  id: number;
  name: string;
  itemTypeName?: string;
  releaseYear?: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
}
export interface DddItemDetail extends DddItemSummary {
  topicItemStats?: { topicId: number; topicName: string; yesSum: number; noSum: number; numComments: number }[];
}
export interface DddRatingRaw {
  yes?: number;
  voteSum?: number;
  isSceneAlert?: boolean;
  index1?: number | null;
  index2?: number | null;
  position1?: number | null;
  position2?: number | null;
  position3?: number | null;
  safePosition1?: number | null;
  safePosition2?: number | null;
  safePosition3?: number | null;
  topicId: number;
}

/** Finds a title by IMDb id or TMDB id. */
export const searchItems = (by: { imdb: string } | { tmdb: number }, timeoutMs: number) =>
  get<DddItemSummary[]>(`/items?${"imdb" in by ? `imdb=${encodeURIComponent(by.imdb)}` : `tmdb=${by.tmdb}`}`, timeoutMs).then((r) => r ?? []);
export const getItem = (id: number, timeoutMs: number) => get<DddItemDetail>(`/items/${id}`, timeoutMs);
export const getRatings = (id: number, timeoutMs: number) => get<DddRatingRaw[]>(`/items/${id}/ratings`, timeoutMs).then((r) => r ?? []);
export const getTopics = (timeoutMs: number) => get<{ id: number; name: string }[]>("/topics", timeoutMs).then((r) => r ?? []);

/** For tests: forget what was remembered in memory. */
export function resetClientMemory(): void {
  usageMemo = null;
  pausedUntilMs = 0;
}
