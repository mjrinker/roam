/**
 * Who may play a title when a server tracks who owns which copy. Pure rules: the database parts are in sessions.ts and owners.ts.
 *
 * - A title nobody owns is watchable by everyone (no one has withdrawn it, and no one has claimed it yet).
 * - An owner can withdraw their copy: all or nothing, for the whole server. With every copy withdrawn, the title can't be played, except
 *   by an owner, who can still play their own copy.
 * - With the limit on, no more people can play a title at once than there are copies shared (a show counts as one title, whatever the
 *   episode). An owner who has withdrawn their copy plays it without using up a shared copy.
 */
export interface OwnershipSettings {
  enabled: boolean;
  claimMode: "instant" | "review";
  limitConcurrent: boolean;
  /** Library kinds the limit covers. */
  limitKinds: string[];
}

export const OFF: OwnershipSettings = { enabled: false, claimMode: "review", limitConcurrent: false, limitKinds: [] };

export interface OwnerCopy {
  accountId: string;
  shared: boolean;
}

export type Availability =
  | { ok: true }
  /** Every copy has been withdrawn. */
  | { ok: false; code: "withdrawn" }
  /** Every shared copy is being played. */
  | { ok: false; code: "busy"; copies: number; inUse: number };

/** Whether the limit applies to this library kind. */
export const limitApplies = (settings: OwnershipSettings, libraryKind: string) => settings.enabled && settings.limitConcurrent && settings.limitKinds.includes(libraryKind);

/**
 * `othersPlaying`: how many players of this title are open right now that are not this viewer's own and not on a withdrawn owner's own
 * copy (those don't use a shared copy).
 */
export function decideAvailability(input: { settings: OwnershipSettings; libraryKind: string; accountId: string; owners: readonly OwnerCopy[]; othersPlaying: number }): Availability {
  const { settings, owners } = input;
  if (!settings.enabled || owners.length === 0) return { ok: true };
  const shared = owners.filter((o) => o.shared).length;
  const mine = owners.find((o) => o.accountId === input.accountId);
  // A household with its own withdrawn copy plays that copy.
  if (mine && !mine.shared) return { ok: true };
  if (shared === 0) return { ok: false, code: "withdrawn" };
  if (limitApplies(settings, input.libraryKind) && input.othersPlaying >= shared) return { ok: false, code: "busy", copies: shared, inUse: input.othersPlaying };
  return { ok: true };
}

/** A player that has been quiet this long is gone (it sends a heartbeat every half minute while playing). */
export const PLAYING_TTL_MS = 90_000;
/** A paused player keeps its place this long. */
export const PAUSE_HOLD_MS = 10 * 60_000;

export interface SessionTimes {
  lastSeenAt: Date;
  pausedAt: Date | null;
}

/** Whether a player still holds its place at `now`. */
export function sessionIsLive(s: SessionTimes, now: Date): boolean {
  if (s.pausedAt) return now.getTime() - s.pausedAt.getTime() < PAUSE_HOLD_MS && now.getTime() - s.lastSeenAt.getTime() < PAUSE_HOLD_MS + PLAYING_TTL_MS;
  return now.getTime() - s.lastSeenAt.getTime() < PLAYING_TTL_MS;
}

/** What to tell someone who can't play. */
export function unavailableMessage(a: Extract<Availability, { ok: false }>): string {
  return a.code === "withdrawn"
    ? "This isn't available right now: everyone who owns a copy has withdrawn it. It can be played again when an owner shares it."
    : a.copies === 1
      ? "The only copy is being played right now. You can wait until it's free."
      : `All ${a.copies} copies are being played right now. You can wait until one is free.`;
}
