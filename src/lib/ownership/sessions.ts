/** Who is playing what right now (for the limit on playing at once), and "tell me when a copy is free". */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { availabilityWatches, episodes, libraries, playbackSessions, seasons, titleExtras, titles } from "@/lib/db/schema";
import type { LibraryKind, TitleKind } from "@/lib/db/schema";
import type { PlayOwnerKind } from "@/lib/player/types";
import { notify } from "@/lib/ownership/notify";
import { loadSettings, ownersOf, type Unit } from "@/lib/ownership/owners";
import { decideAvailability, limitApplies, sessionIsLive, type Availability, type OwnerCopy } from "@/lib/ownership/rules";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface PlayUnit extends Unit {
  serverId: string;
  libraryKind: LibraryKind;
  titleName: string;
  titleKind: TitleKind;
  /** An extra (a bonus feature) is gated like its movie but takes no place of its own. */
  isExtra: boolean;
}

/** The title or season that playing this owner is a use of. Null if it doesn't exist. */
export async function playUnitFor(ex: Db, ownerKind: PlayOwnerKind, ownerId: string): Promise<PlayUnit | null> {
  const base = { serverId: libraries.serverId, libraryKind: libraries.kind, titleName: titles.name, titleKind: titles.kind, titleId: titles.id };
  if (ownerKind === "title") {
    const [r] = await ex.select(base).from(titles).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(titles.id, ownerId)).limit(1);
    return r ? { ...r, seasonId: null, isExtra: false } : null;
  }
  if (ownerKind === "extra") {
    const [r] = await ex.select(base).from(titleExtras).innerJoin(titles, eq(titleExtras.titleId, titles.id)).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(titleExtras.id, ownerId)).limit(1);
    return r ? { ...r, seasonId: null, isExtra: true } : null;
  }
  const [r] = await ex.select({ ...base, seasonId: seasons.id }).from(episodes).innerJoin(seasons, eq(episodes.seasonId, seasons.id)).innerJoin(titles, eq(seasons.titleId, titles.id)).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(episodes.id, ownerId)).limit(1);
  return r ? { ...r, isExtra: false } : null;
}

const sessionIs = (u: Unit) => and(eq(playbackSessions.titleId, u.titleId), u.seasonId ? eq(playbackSessions.seasonId, u.seasonId) : isNull(playbackSessions.seasonId))!;

/** Live players of this unit, other than this viewer's own, not counting those playing their own withdrawn copy. */
async function othersPlaying(ex: Db, unit: Unit, viewerId: string, owners: OwnerCopy[], now: Date): Promise<number> {
  const rows = await ex.select().from(playbackSessions).where(and(sessionIs(unit), ne(playbackSessions.viewerId, viewerId)));
  const withdrawn = new Set(owners.filter((o) => !o.shared).map((o) => o.accountId));
  return rows.filter((r) => sessionIsLive(r, now) && !withdrawn.has(r.accountId)).length;
}

/** May this viewer play this now? (Nothing is recorded.) */
export async function availabilityFor(ex: Db, unit: PlayUnit, viewer: { viewerId: string; accountId: string }, now = new Date()): Promise<Availability> {
  const settings = await loadSettings(ex, unit.serverId);
  if (!settings.enabled) return { ok: true };
  const owners = await ownersOf(ex, unit);
  const playing = limitApplies(settings, unit.libraryKind) && !unit.isExtra ? await othersPlaying(ex, unit, viewer.viewerId, owners, now) : 0;
  return decideAvailability({ settings, libraryKind: unit.libraryKind, accountId: viewer.accountId, owners, othersPlaying: playing });
}

/** Whether this play takes a place (only when the server limits playing at once for this kind of library). */
export async function takesAPlace(ex: Db, unit: PlayUnit): Promise<boolean> {
  if (unit.isExtra) return false;
  const settings = await loadSettings(ex, unit.serverId);
  return limitApplies(settings, unit.libraryKind);
}

/** A viewer starts or keeps playing: takes a place if there is one. A viewer plays one thing at a time, so any other place they held is let go. */
export async function beat(ex: Db, unit: PlayUnit, viewer: { viewerId: string; accountId: string }, paused: boolean, now = new Date()): Promise<Availability> {
  const available = await availabilityFor(ex, unit, viewer, now);
  if (!available.ok || !(await takesAPlace(ex, unit))) return available;
  const [previous] = await ex.select().from(playbackSessions).where(eq(playbackSessions.viewerId, viewer.viewerId)).limit(1);
  const moved = previous && !(previous.titleId === unit.titleId && previous.seasonId === unit.seasonId) ? previous : null;
  await ex
    .insert(playbackSessions)
    .values({ serverId: unit.serverId, titleId: unit.titleId, seasonId: unit.seasonId, accountId: viewer.accountId, viewerId: viewer.viewerId, startedAt: now, lastSeenAt: now, pausedAt: paused ? now : null })
    .onConflictDoUpdate({
      target: playbackSessions.viewerId,
      set: {
        serverId: unit.serverId,
        titleId: unit.titleId,
        seasonId: unit.seasonId,
        accountId: viewer.accountId,
        lastSeenAt: now,
        // Staying paused keeps the time it was first paused; playing clears it. A different title starts over.
        pausedAt: paused ? sql`case when ${playbackSessions.titleId} = ${unit.titleId} and ${playbackSessions.pausedAt} is not null then ${playbackSessions.pausedAt} else ${now} end` : null,
        startedAt: sql`case when ${playbackSessions.titleId} = ${unit.titleId} and coalesce(${playbackSessions.seasonId}, ${playbackSessions.titleId}) = coalesce(${unit.seasonId}::uuid, ${unit.titleId}::uuid) then ${playbackSessions.startedAt} else ${now} end`,
      },
    });
  if (moved) await announceFreed(ex, { titleId: moved.titleId, seasonId: moved.seasonId }, now);
  return { ok: true };
}

/** A viewer stops playing (or closes the player). */
export async function endPlay(ex: Db, viewerId: string, now = new Date()): Promise<void> {
  const rows = await ex.delete(playbackSessions).where(eq(playbackSessions.viewerId, viewerId)).returning({ titleId: playbackSessions.titleId, seasonId: playbackSessions.seasonId });
  for (const r of rows) await announceFreed(ex, r, now);
}

/** Lets go of players that went quiet, and tells whoever was waiting for what they held. */
export async function purgeStale(ex: Db, now = new Date(), onlyTitleIds?: string[]): Promise<number> {
  if (onlyTitleIds && onlyTitleIds.length === 0) return 0;
  const rows = await ex.select().from(playbackSessions).where(onlyTitleIds ? inArray(playbackSessions.titleId, onlyTitleIds) : undefined);
  const stale = rows.filter((r) => !sessionIsLive(r, now));
  if (stale.length === 0) return 0;
  await ex.delete(playbackSessions).where(inArray(playbackSessions.id, stale.map((r) => r.id)));
  const seen = new Set<string>();
  for (const r of stale) {
    const key = `${r.titleId}/${r.seasonId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await announceFreed(ex, { titleId: r.titleId, seasonId: r.seasonId }, now);
  }
  return stale.length;
}

/** Lets go of quiet players of what this account is waiting for (so being told doesn't depend on anyone else's page being open). */
export async function sweepForWatcher(ex: Db, accountId: string, now = new Date()): Promise<void> {
  const waiting = await ex.select({ titleId: availabilityWatches.titleId }).from(availabilityWatches).where(eq(availabilityWatches.accountId, accountId));
  if (waiting.length) await purgeStale(ex, now, [...new Set(waiting.map((w) => w.titleId))]);
}

// ── "Tell me when it's free" ──────────────────────────────────────────────

export async function watchForAvailability(ex: Db, unit: Unit, viewer: { viewerId: string; accountId: string }): Promise<void> {
  await ex.insert(availabilityWatches).values({ titleId: unit.titleId, seasonId: unit.seasonId, viewerId: viewer.viewerId, accountId: viewer.accountId }).onConflictDoNothing();
}

export async function stopWatching(ex: Db, unit: Unit, viewerId: string): Promise<void> {
  await ex.delete(availabilityWatches).where(and(eq(availabilityWatches.viewerId, viewerId), eq(availabilityWatches.titleId, unit.titleId), unit.seasonId ? eq(availabilityWatches.seasonId, unit.seasonId) : isNull(availabilityWatches.seasonId)));
}

export async function isWatching(ex: Db, unit: Unit, viewerId: string): Promise<boolean> {
  const [r] = await ex.select({ id: availabilityWatches.id }).from(availabilityWatches).where(and(eq(availabilityWatches.viewerId, viewerId), eq(availabilityWatches.titleId, unit.titleId), unit.seasonId ? eq(availabilityWatches.seasonId, unit.seasonId) : isNull(availabilityWatches.seasonId))).limit(1);
  return !!r;
}

/**
 * Something that held a copy let go (or an owner shared theirs): if a copy is free now, tell the people who asked, once each (their request
 * is spent when they are told). Whoever starts playing first takes the copy; the rest can ask again.
 */
export async function announceFreed(ex: Db, unit: Unit, now = new Date()): Promise<number> {
  const waiting = await ex.select().from(availabilityWatches).where(and(eq(availabilityWatches.titleId, unit.titleId), unit.seasonId ? eq(availabilityWatches.seasonId, unit.seasonId) : isNull(availabilityWatches.seasonId)));
  if (waiting.length === 0) return 0;
  const [t] = await ex.select({ id: titles.id, name: titles.name, serverId: libraries.serverId, kind: libraries.kind }).from(titles).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(titles.id, unit.titleId)).limit(1);
  if (!t) return 0;
  const settings = await loadSettings(ex, t.serverId);
  const owners = await ownersOf(ex, unit);
  const shared = owners.filter((o) => o.shared).length;
  const taken = (await ex.select().from(playbackSessions).where(sessionIs(unit))).filter((r) => sessionIsLive(r, now)).length;
  if (!settings.enabled || shared === 0 || (limitApplies(settings, t.kind) && taken >= shared)) return 0;
  const [season] = unit.seasonId ? await ex.select({ n: seasons.number }).from(seasons).where(eq(seasons.id, unit.seasonId)).limit(1) : [];
  const what = season ? `“${t.name}”, season ${season.n},` : `“${t.name}”`;
  for (const w of waiting) {
    await notify(ex, { accountId: w.accountId, serverId: t.serverId, kind: "available", titleId: t.id, message: `${what} is free to watch now.`, href: `/s/${t.serverId}/title/${t.id}` });
  }
  await ex.delete(availabilityWatches).where(inArray(availabilityWatches.id, waiting.map((w) => w.id)));
  return waiting.length;
}
