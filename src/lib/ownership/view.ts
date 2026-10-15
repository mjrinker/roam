/** What the title page and the admin page show about ownership. */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ownershipClaims, seasons, titleOwners, titles, type ClaimStatus } from "@/lib/db/schema";
import { householdNames, loadSettings, serverHouseholds } from "@/lib/ownership/owners";
import { decideAvailability, type OwnershipSettings } from "@/lib/ownership/rules";
import { isWatching } from "@/lib/ownership/sessions";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface UnitView {
  seasonId: string | null;
  /** "Season 2" for a season, null for a movie, book or album. */
  label: string | null;
  owners: { accountId: string; name: string; shared: boolean; mine: boolean }[];
  iOwn: boolean;
  /** My copy is shared with the server (only meaningful when I own it). */
  myShared: boolean;
  myClaim: { id: string; status: ClaimStatus; note: string | null } | null;
  /** Whether this viewer can play it right now, and if not why. */
  playable: boolean;
  blockedBy: "withdrawn" | "busy" | null;
  watching: boolean;
}

export interface OwnershipView {
  serverId: string;
  settings: OwnershipSettings;
  units: UnitView[];
  /** For the admin: who can be made an owner. */
  households: { accountId: string; name: string; isAdmin: boolean }[];
}

/** Null when the server doesn't track ownership (nothing to show). */
export async function ownershipView(ex: Db, opts: { serverId: string; titleId: string; libraryKind: string; accountId: string; viewerId: string; isAdmin: boolean }): Promise<OwnershipView | null> {
  const settings = await loadSettings(ex, opts.serverId);
  if (!settings.enabled) return null;
  const [t] = await ex.select({ kind: titles.kind }).from(titles).where(eq(titles.id, opts.titleId)).limit(1);
  if (!t) return null;
  const seasonRows = t.kind === "show" ? await ex.select({ id: seasons.id, number: seasons.number }).from(seasons).where(eq(seasons.titleId, opts.titleId)).orderBy(asc(seasons.number)) : [];
  const unitList: { seasonId: string | null; label: string | null }[] = t.kind === "show" ? seasonRows.map((s) => ({ seasonId: s.id, label: `Season ${s.number}` })) : [{ seasonId: null, label: null }];

  const owners = await ex.select().from(titleOwners).where(eq(titleOwners.titleId, opts.titleId));
  const claims = await ex.select().from(ownershipClaims).where(and(eq(ownershipClaims.titleId, opts.titleId), eq(ownershipClaims.accountId, opts.accountId), inArray(ownershipClaims.status, ["pending", "evidence_requested", "evidence_submitted", "rejected"] as ClaimStatus[])));
  const names = await householdNames(ex, [...new Set(owners.map((o) => o.accountId))], opts.isAdmin);

  const units: UnitView[] = [];
  for (const u of unitList) {
    const here = owners.filter((o) => (o.seasonId ?? null) === u.seasonId);
    const mine = here.find((o) => o.accountId === opts.accountId);
    // A rejected claim is only shown until a new one is made; the latest decides.
    const claim = claims.filter((c) => (c.seasonId ?? null) === u.seasonId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const verdict = decideAvailability({ settings: { ...settings, limitConcurrent: false }, libraryKind: opts.libraryKind, accountId: opts.accountId, owners: here, othersPlaying: 0 });
    units.push({
      seasonId: u.seasonId,
      label: u.label,
      owners: here.map((o) => ({ accountId: o.accountId, name: names.get(o.accountId) ?? "A household", shared: o.shared, mine: o.accountId === opts.accountId })),
      iOwn: !!mine,
      myShared: mine?.shared ?? false,
      myClaim: claim ? { id: claim.id, status: claim.status, note: claim.adminNote } : null,
      playable: verdict.ok,
      blockedBy: verdict.ok ? null : "withdrawn",
      watching: await isWatching(ex, { titleId: opts.titleId, seasonId: u.seasonId }, opts.viewerId),
    });
  }
  return { serverId: opts.serverId, settings, units, households: opts.isAdmin ? await serverHouseholds(ex, opts.serverId) : [] };
}

