/**
 * What Roam knows from Does the Dog Die about a title, asked for only when someone needs it and kept (per their API Terms, "to improve
 * performance" and refreshed at least every 30 days) so each title costs a few requests once, shared by everyone on the deployment.
 *
 * A server's access level says when it may ask: "full" when a title's page opens or someone is about to play it; "limited" only when
 * someone is about to play it; "disabled" never. Nothing is ever asked in bulk or ahead of need.
 */
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dddItems } from "@/lib/db/schema";
import { DddError, dddConfigured, getItem, getRatings, getTopics, mayAsk as mayAskNow, searchItems, type DddItemSummary } from "@/lib/ddd/client";
import { momentsFromRatings } from "@/lib/ddd/transform";
import type { DddReference, DddStat, DddTitleData } from "@/lib/ddd/types";

const DAY = 86_400_000;
/** Kept this long before being asked for again when someone next needs it. */
export const REFRESH_AFTER_MS = 25 * DAY;
/** Never used past this (their terms: refreshed at least every 30 days). */
export const EXPIRES_AFTER_MS = 30 * DAY;
/** A title they don't have is looked for again after this. */
const ABSENT_RECHECK_MS = 7 * DAY;

export type DddAccess = "disabled" | "limited" | "full";
/** "page": a title's page is opening. "play": someone is about to play it (the choices dialog, or playback itself). */
export type DddWhen = "page" | "play";

export interface DddLookup {
  imdbId: string | null;
  tmdbId: number | null;
  kind: "movie" | "tv";
}

export type DddResult =
  | { status: "ok"; data: DddTitleData; fetchedAt: Date }
  /** Off for this server, or no key, or nothing to look the title up by. */
  | { status: "off" }
  /** They have no such title. */
  | { status: "absent" }
  /** Asked, and couldn't get an answer (busy, out of allowance, down). */
  | { status: "unavailable"; reason: string }
  /** Nothing kept yet, and this is not a moment this server's access level asks. */
  | { status: "later" };

export const lookupKey = (l: DddLookup): string | null => (l.imdbId ? `imdb:${l.imdbId}` : l.tmdbId ? `tmdb:${l.kind}:${l.tmdbId}` : null);

/** Whether this access level asks at this moment. */
export const mayAsk = (access: DddAccess, when: DddWhen): boolean => (access === "full" ? true : access === "limited" ? when === "play" : false);

const inFlight = new Map<string, Promise<DddResult>>();

async function topicNames(timeoutMs: number): Promise<Map<number, string>> {
  const [row] = await db.select().from(dddItems).where(eq(dddItems.key, "ref:topics")).limit(1);
  const fresh = row && Date.now() - row.fetchedAt.getTime() < REFRESH_AFTER_MS;
  let topics = (row?.data as DddReference | undefined)?.topics;
  if (!fresh || !topics) {
    try {
      const got = await getTopics(timeoutMs);
      topics = got.map((t) => ({ id: t.id, name: t.name }));
      const data: DddReference = { topics };
      await db.insert(dddItems).values({ key: "ref:topics", data, fetchedAt: new Date() }).onConflictDoUpdate({ target: dddItems.key, set: { data, fetchedAt: new Date() } });
    } catch (err) {
      // An old list still names topics (it only grows); no list at all means asking is for nothing.
      if (!topics || (row && Date.now() - row.fetchedAt.getTime() >= EXPIRES_AFTER_MS)) throw err;
    }
  }
  return new Map((topics ?? []).map((t) => [t.id, t.name]));
}

function pick(items: DddItemSummary[], kind: "movie" | "tv"): DddItemSummary | null {
  const wanted = (i: DddItemSummary) => (kind === "movie" ? /movie|film/i.test(i.itemTypeName ?? "") : /tv|show|series/i.test(i.itemTypeName ?? ""));
  return items.find(wanted) ?? null;
}

async function fetchTitle(key: string, l: DddLookup, needStats: boolean, known: { dddItemId: number | null; data: DddTitleData | null; fresh: boolean } | null, deadline: number): Promise<DddResult> {
  const left = () => Math.max(300, deadline - Date.now());
  try {
    let id = known?.dddItemId ?? null;
    let name = known?.data?.name ?? "";
    if (id === null) {
      let found = l.imdbId ? pick(await searchItems({ imdb: l.imdbId }, left()), l.kind) : null;
      if (!found && l.tmdbId) found = pick(await searchItems({ tmdb: l.tmdbId }, left()), l.kind);
      if (!found) {
        await db.insert(dddItems).values({ key, missing: true, dddItemId: null, data: null, fetchedAt: new Date() }).onConflictDoUpdate({ target: dddItems.key, set: { missing: true, dddItemId: null, data: null, fetchedAt: new Date() } });
        return { status: "absent" };
      }
      id = found.id;
      name = found.name;
    }
    // Only the counts are missing from something kept recently: its scenes are still good, so they are not asked for again.
    const moments = known?.fresh && known.data ? known.data.moments : momentsFromRatings(await getRatings(id, left()), await topicNames(left()));
    let stats: DddStat[] | null = known?.data?.stats ?? null;
    if (needStats) {
      const detail = await getItem(id, left());
      stats = (detail?.topicItemStats ?? []).map((s) => ({ topicId: s.topicId, topicName: s.topicName, yes: s.yesSum, no: s.noSum, comments: s.numComments }));
      name = detail?.name ?? name;
    }
    const data: DddTitleData = { name, kind: l.kind, stats, moments };
    const fetchedAt = new Date();
    await db.insert(dddItems).values({ key, dddItemId: id, missing: false, data, fetchedAt }).onConflictDoUpdate({ target: dddItems.key, set: { dddItemId: id, missing: false, data, fetchedAt } });
    return { status: "ok", data, fetchedAt };
  } catch (err) {
    return { status: "unavailable", reason: err instanceof DddError ? err.reason : "error" };
  }
}

/**
 * The community's answer for a title, from what is kept or by asking (when this access level and moment allow). `needStats` is for a page
 * that shows the topic counts (a play only needs the scenes). Never waits longer than `timeoutMs` for them.
 */
export async function dddFor(lookup: DddLookup, access: DddAccess, when: DddWhen, opts: { needStats?: boolean; timeoutMs?: number } = {}): Promise<DddResult> {
  const key = lookupKey(lookup);
  if (access === "disabled" || !dddConfigured() || !key) return { status: "off" };
  const [row] = await db.select().from(dddItems).where(eq(dddItems.key, key)).limit(1);
  const age = row ? Date.now() - row.fetchedAt.getTime() : Infinity;
  const usable = row && age < EXPIRES_AFTER_MS;

  if (usable && row.missing && age < ABSENT_RECHECK_MS) return { status: "absent" };
  const data = usable && !row.missing ? (row.data as DddTitleData | null) : null;
  const wantsStats = !!opts.needStats && data !== null && data.stats === null;
  const stale = age >= REFRESH_AFTER_MS || (usable && row.missing) || wantsStats;
  if (data && !stale) return { status: "ok", data, fetchedAt: row.fetchedAt };

  // Needs asking (nothing kept, kept too long, or the counts are wanted and missing). Only at a moment this access level asks.
  if (!mayAsk(access, when)) return data ? { status: "ok", data, fetchedAt: row!.fetchedAt } : usable && row.missing ? { status: "absent" } : { status: "later" };

  // Out of allowance, or asked to slow down: nothing is asked, and what is kept (if anything) is the answer.
  const blocked = await mayAskNow({ budget: true });
  if (blocked) return data ? { status: "ok", data, fetchedAt: row!.fetchedAt } : { status: "unavailable", reason: blocked };

  const flightKey = `${key}|${opts.needStats ? "s" : ""}`;
  const running = inFlight.get(flightKey);
  if (running) return running;
  const job = fetchTitle(key, lookup, !!opts.needStats, row && !row.missing ? { dddItemId: row.dddItemId, data, fresh: age < REFRESH_AFTER_MS } : null, Date.now() + (opts.timeoutMs ?? 2500)).then((r) =>
    // Asking failed but something recent enough is kept: that is still the best answer.
    r.status === "unavailable" && data ? { status: "ok" as const, data, fetchedAt: row!.fetchedAt } : r
  );
  inFlight.set(flightKey, job);
  try {
    return await job;
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Deletes what is kept past the 30-day limit. Run by the daily job. */
export async function deleteExpiredDdd(now = new Date()): Promise<number> {
  const rows = await db.delete(dddItems).where(and(lt(dddItems.fetchedAt, new Date(now.getTime() - EXPIRES_AFTER_MS)))).returning({ key: dddItems.key });
  return rows.length;
}
