/** Who owns which title, and the process by which a member comes to own one. */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, ownershipClaims, ownershipEvidence, seasons, serverMembers, servers, titleOwners, titles, viewers, type ClaimStatus } from "@/lib/db/schema";
import { notify, notifyAdmins } from "@/lib/ownership/notify";
import type { OwnerCopy, OwnershipSettings } from "@/lib/ownership/rules";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const MAX_EVIDENCE_PICTURES = 3;
/** About 600 KB of picture once encoded; the browser shrinks a photo to fit before sending it. */
export const MAX_EVIDENCE_CHARS = 800_000;
const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function loadSettings(ex: Db, serverId: string): Promise<OwnershipSettings> {
  const [s] = await ex.select({ enabled: servers.ownershipEnabled, claimMode: servers.claimMode, limitConcurrent: servers.limitConcurrent, limitKinds: servers.limitKinds }).from(servers).where(eq(servers.id, serverId)).limit(1);
  return s ?? { enabled: false, claimMode: "review", limitConcurrent: false, limitKinds: [] };
}

export async function saveSettings(ex: Db, serverId: string, patch: Partial<OwnershipSettings>): Promise<OwnershipSettings> {
  const set: Partial<typeof servers.$inferInsert> = {};
  if (patch.enabled !== undefined) set.ownershipEnabled = patch.enabled;
  if (patch.claimMode !== undefined) set.claimMode = patch.claimMode;
  if (patch.limitConcurrent !== undefined) set.limitConcurrent = patch.limitConcurrent;
  if (patch.limitKinds !== undefined) set.limitKinds = patch.limitKinds;
  if (Object.keys(set).length > 0) await ex.update(servers).set(set).where(eq(servers.id, serverId));
  return loadSettings(ex, serverId);
}

/** What is owned: a movie, book or album as a whole, or one season of a show. */
export interface Unit {
  titleId: string;
  seasonId: string | null;
}

const ownerIs = (u: Unit): SQL => and(eq(titleOwners.titleId, u.titleId), u.seasonId ? eq(titleOwners.seasonId, u.seasonId) : isNull(titleOwners.seasonId))!;
const claimIs = (u: Unit): SQL => and(eq(ownershipClaims.titleId, u.titleId), u.seasonId ? eq(ownershipClaims.seasonId, u.seasonId) : isNull(ownershipClaims.seasonId))!;

export async function ownersOf(ex: Db, unit: Unit): Promise<OwnerCopy[]> {
  return ex.select({ accountId: titleOwners.accountId, shared: titleOwners.shared }).from(titleOwners).where(ownerIs(unit));
}

/** The units a whole title stands for: each season of a show, otherwise the title itself. */
export async function unitsOfTitles(ex: Db, titleIds: string[]): Promise<Unit[]> {
  if (titleIds.length === 0) return [];
  const rows = await ex.select({ id: titles.id, kind: titles.kind }).from(titles).where(inArray(titles.id, titleIds));
  const showIds = rows.filter((r) => r.kind === "show").map((r) => r.id);
  const seasonRows = showIds.length ? await ex.select({ id: seasons.id, titleId: seasons.titleId }).from(seasons).where(inArray(seasons.titleId, showIds)) : [];
  return [...rows.filter((r) => r.kind !== "show").map((r) => ({ titleId: r.id, seasonId: null })), ...seasonRows.map((r) => ({ titleId: r.titleId, seasonId: r.id }))];
}

/**
 * What to call a household where others can see it: the name of the account's main (owner) profile, or "A household" when that profile
 * is hidden from the server. A server's admin sees every name.
 */
export async function householdNames(ex: Db, accountIds: string[], forAdmin = false): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await ex.select({ accountId: viewers.accountId, name: viewers.name, visible: viewers.visibleOnServer }).from(viewers).where(and(inArray(viewers.accountId, accountIds), eq(viewers.role, "owner")));
  return new Map(accountIds.map((id) => { const v = rows.find((r) => r.accountId === id); return [id, v && (v.visible || forAdmin) ? v.name : "A household"]; }));
}

/** Everyone on the server as a household, for the admin's pickers. */
export async function serverHouseholds(ex: Db, serverId: string): Promise<{ accountId: string; name: string; isAdmin: boolean }[]> {
  const members = await ex.select({ accountId: serverMembers.profileId, role: serverMembers.role }).from(serverMembers).where(eq(serverMembers.serverId, serverId));
  const names = await householdNames(ex, members.map((m) => m.accountId), true);
  return members.map((m) => ({ accountId: m.accountId, name: names.get(m.accountId) ?? "A household", isAdmin: m.role === "admin" })).sort((x, y) => x.name.localeCompare(y.name));
}

/** Only units of this server count, and only members of it can own. Returns the units that were not owned by this account before. */
export async function assignOwners(ex: Db, opts: { serverId: string; units: Unit[]; accountId: string; via: "assigned" | "claimed" }): Promise<Unit[]> {
  if (opts.units.length === 0) return [];
  const [member] = await ex.select({ id: serverMembers.id }).from(serverMembers).where(and(eq(serverMembers.serverId, opts.serverId), eq(serverMembers.profileId, opts.accountId))).limit(1);
  if (!member) return [];
  const inServer = await ex.select({ id: titles.id }).from(titles).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(and(eq(libraries.serverId, opts.serverId), inArray(titles.id, [...new Set(opts.units.map((u) => u.titleId))])));
  const okTitles = new Set(inServer.map((t) => t.id));
  // A season has to belong to the title it is given with.
  const seasonIds = opts.units.filter((u) => u.seasonId).map((u) => u.seasonId!);
  const seasonRows = seasonIds.length ? await ex.select({ id: seasons.id, titleId: seasons.titleId }).from(seasons).where(inArray(seasons.id, seasonIds)) : [];
  const seasonTitle = new Map(seasonRows.map((r) => [r.id, r.titleId]));
  const valid = opts.units.filter((u) => okTitles.has(u.titleId) && (!u.seasonId || seasonTitle.get(u.seasonId) === u.titleId));
  const added: Unit[] = [];
  for (let i = 0; i < valid.length; i += 500) {
    const batch = valid.slice(i, i + 500);
    const rows = await ex.insert(titleOwners).values(batch.map((u) => ({ titleId: u.titleId, seasonId: u.seasonId, accountId: opts.accountId, via: opts.via }))).onConflictDoNothing().returning({ titleId: titleOwners.titleId, seasonId: titleOwners.seasonId });
    added.push(...rows);
  }
  return added;
}

export async function removeOwner(ex: Db, unit: Unit, accountId: string): Promise<void> {
  await ex.delete(titleOwners).where(and(ownerIs(unit), eq(titleOwners.accountId, accountId)));
}

/** Shares this household's copy with the whole server, or withdraws it. Returns false if the household doesn't own it. */
export async function setShared(ex: Db, unit: Unit, accountId: string, shared: boolean): Promise<boolean> {
  const rows = await ex.update(titleOwners).set({ shared }).where(and(ownerIs(unit), eq(titleOwners.accountId, accountId))).returning({ id: titleOwners.id });
  return rows.length > 0;
}

// ── Claims ───────────────────────────────────────────────────────────────

export type ClaimOutcome = { status: "owned" | "pending" } | { status: "already_owner" | "already_pending" | "disabled" | "not_found" };

const OPEN: ClaimStatus[] = ["pending", "evidence_requested", "evidence_submitted"];

async function titleInfo(ex: Db, titleId: string) {
  const [t] = await ex.select({ id: titles.id, name: titles.name, kind: titles.kind, serverId: libraries.serverId }).from(titles).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(titles.id, titleId)).limit(1);
  return t ?? null;
}

/** "Name", or "Name, season 2" for a season. */
const label = (name: string, seasonNumber: number | null) => (seasonNumber === null ? `“${name}”` : `“${name}”, season ${seasonNumber}`);

async function seasonNumberOf(ex: Db, seasonId: string | null): Promise<number | null> {
  if (!seasonId) return null;
  const [r] = await ex.select({ n: seasons.number }).from(seasons).where(eq(seasons.id, seasonId)).limit(1);
  return r?.n ?? null;
}

/** A member says they own a copy. Settled at once or left for the admin, as the server decides. */
export async function submitClaim(ex: Db, opts: { titleId: string; seasonId?: string | null; accountId: string }): Promise<ClaimOutcome> {
  const t = await titleInfo(ex, opts.titleId);
  if (!t) return { status: "not_found" };
  // A show is claimed one season at a time; anything else as a whole.
  const seasonId = t.kind === "show" ? (opts.seasonId ?? null) : null;
  if (t.kind === "show" && !seasonId) return { status: "not_found" };
  const seasonNumber = await seasonNumberOf(ex, seasonId);
  if (seasonId) {
    const [own] = await ex.select({ id: seasons.id }).from(seasons).where(and(eq(seasons.id, seasonId), eq(seasons.titleId, t.id))).limit(1);
    if (!own) return { status: "not_found" };
  }
  const unit: Unit = { titleId: t.id, seasonId };
  const settings = await loadSettings(ex, t.serverId);
  if (!settings.enabled) return { status: "disabled" };
  const [member] = await ex.select({ id: serverMembers.id }).from(serverMembers).where(and(eq(serverMembers.serverId, t.serverId), eq(serverMembers.profileId, opts.accountId))).limit(1);
  if (!member) return { status: "not_found" };
  const [owns] = await ex.select({ id: titleOwners.id }).from(titleOwners).where(and(ownerIs(unit), eq(titleOwners.accountId, opts.accountId))).limit(1);
  if (owns) return { status: "already_owner" };
  const [open] = await ex.select({ id: ownershipClaims.id }).from(ownershipClaims).where(and(claimIs(unit), eq(ownershipClaims.accountId, opts.accountId), inArray(ownershipClaims.status, OPEN))).limit(1);
  if (open) return { status: "already_pending" };
  if (settings.claimMode === "instant") {
    await ex.insert(ownershipClaims).values({ titleId: t.id, seasonId, accountId: opts.accountId, status: "approved", decidedAt: new Date() });
    await assignOwners(ex, { serverId: t.serverId, units: [unit], accountId: opts.accountId, via: "claimed" });
    return { status: "owned" };
  }
  await ex.insert(ownershipClaims).values({ titleId: t.id, seasonId, accountId: opts.accountId, status: "pending" });
  await notifyAdmins(ex, t.serverId, { kind: "claim_waiting", titleId: t.id, message: `A claim to own ${label(t.name, seasonNumber)} is waiting for review.`, href: `/s/${t.serverId}/admin#claims` });
  return { status: "pending" };
}

export type Decision = { kind: "approve" } | { kind: "reject"; note?: string } | { kind: "evidence"; note: string };

/** The admin settles a claim, or asks for evidence. Returns false when the claim isn't open or isn't on this server. */
export async function decideClaim(ex: Db, opts: { serverId: string; claimId: string; decision: Decision }): Promise<boolean> {
  const [claim] = await ex
    .select({ id: ownershipClaims.id, titleId: ownershipClaims.titleId, seasonId: ownershipClaims.seasonId, accountId: ownershipClaims.accountId, status: ownershipClaims.status, name: titles.name })
    .from(ownershipClaims)
    .innerJoin(titles, eq(ownershipClaims.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(ownershipClaims.id, opts.claimId), eq(libraries.serverId, opts.serverId)))
    .limit(1);
  if (!claim || !OPEN.includes(claim.status)) return false;
  const href = `/s/${opts.serverId}/title/${claim.titleId}`;
  const what = label(claim.name, await seasonNumberOf(ex, claim.seasonId));
  const d = opts.decision;
  if (d.kind === "evidence") {
    await ex.update(ownershipClaims).set({ status: "evidence_requested", adminNote: d.note.slice(0, 500) }).where(eq(ownershipClaims.id, claim.id));
    await notify(ex, { accountId: claim.accountId, serverId: opts.serverId, kind: "evidence_requested", titleId: claim.titleId, message: `The admin asked for evidence that you own ${what}: ${d.note.slice(0, 200)}`, href });
    return true;
  }
  if (d.kind === "approve") {
    await assignOwners(ex, { serverId: opts.serverId, units: [{ titleId: claim.titleId, seasonId: claim.seasonId }], accountId: claim.accountId, via: "claimed" });
    await ex.update(ownershipClaims).set({ status: "approved", decidedAt: new Date(), adminNote: null }).where(eq(ownershipClaims.id, claim.id));
    await notify(ex, { accountId: claim.accountId, serverId: opts.serverId, kind: "claim_approved", titleId: claim.titleId, message: `You now own ${what}.`, href });
  } else {
    await ex.update(ownershipClaims).set({ status: "rejected", decidedAt: new Date(), adminNote: d.note?.slice(0, 500) ?? null }).where(eq(ownershipClaims.id, claim.id));
    await notify(ex, { accountId: claim.accountId, serverId: opts.serverId, kind: "claim_rejected", titleId: claim.titleId, message: `Your claim to ${what} wasn't accepted${d.note ? `: ${d.note.slice(0, 200)}` : "."}`, href });
  }
  // A decision is final: the pictures are not kept.
  await ex.delete(ownershipEvidence).where(eq(ownershipEvidence.claimId, claim.id));
  return true;
}

export type EvidenceOutcome = "ok" | "not_requested" | "too_many" | "bad_picture";

/** The claimant sends a picture the admin asked for. */
export async function addEvidence(ex: Db, opts: { claimId: string; accountId: string; contentType: string; dataBase64: string }): Promise<EvidenceOutcome> {
  if (!PICTURE_TYPES.has(opts.contentType) || opts.dataBase64.length === 0 || opts.dataBase64.length > MAX_EVIDENCE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(opts.dataBase64)) return "bad_picture";
  const [claim] = await ex.select({ id: ownershipClaims.id, status: ownershipClaims.status, titleId: ownershipClaims.titleId, seasonId: ownershipClaims.seasonId }).from(ownershipClaims).where(and(eq(ownershipClaims.id, opts.claimId), eq(ownershipClaims.accountId, opts.accountId))).limit(1);
  if (!claim || (claim.status !== "evidence_requested" && claim.status !== "evidence_submitted")) return "not_requested";
  const [count] = await ex.select({ n: sql<number>`count(*)::int` }).from(ownershipEvidence).where(eq(ownershipEvidence.claimId, claim.id));
  if ((count?.n ?? 0) >= MAX_EVIDENCE_PICTURES) return "too_many";
  await ex.insert(ownershipEvidence).values({ claimId: claim.id, contentType: opts.contentType, dataBase64: opts.dataBase64 });
  if (claim.status === "evidence_requested") {
    await ex.update(ownershipClaims).set({ status: "evidence_submitted" }).where(eq(ownershipClaims.id, claim.id));
    const info = await titleInfo(ex, claim.titleId);
    if (info) await notifyAdmins(ex, info.serverId, { kind: "claim_waiting", titleId: info.id, message: `Evidence arrived for the claim to ${label(info.name, await seasonNumberOf(ex, claim.seasonId))}.`, href: `/s/${info.serverId}/admin#claims` });
  }
  return "ok";
}

export interface ClaimRow {
  id: string;
  titleId: string;
  titleName: string;
  /** For a show: which season. */
  seasonNumber: number | null;
  accountId: string;
  household: string;
  status: ClaimStatus;
  adminNote: string | null;
  createdAt: Date;
  pictures: { id: string; contentType: string }[];
}

/** The server's open claims, oldest first, with who made them (the admin sees full names). */
export async function openClaims(ex: Db, serverId: string): Promise<ClaimRow[]> {
  const rows = await ex
    .select({ id: ownershipClaims.id, titleId: ownershipClaims.titleId, titleName: titles.name, seasonNumber: seasons.number, accountId: ownershipClaims.accountId, status: ownershipClaims.status, adminNote: ownershipClaims.adminNote, createdAt: ownershipClaims.createdAt })
    .from(ownershipClaims)
    .innerJoin(titles, eq(ownershipClaims.titleId, titles.id))
    .leftJoin(seasons, eq(ownershipClaims.seasonId, seasons.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(libraries.serverId, serverId), inArray(ownershipClaims.status, OPEN)))
    .orderBy(asc(ownershipClaims.createdAt));
  const names = await householdNames(ex, [...new Set(rows.map((r) => r.accountId))], true);
  const pics = rows.length ? await ex.select({ id: ownershipEvidence.id, claimId: ownershipEvidence.claimId, contentType: ownershipEvidence.contentType }).from(ownershipEvidence).where(inArray(ownershipEvidence.claimId, rows.map((r) => r.id))) : [];
  return rows.map((r) => ({ ...r, household: names.get(r.accountId) ?? "A household", pictures: pics.filter((p) => p.claimId === r.id).map((p) => ({ id: p.id, contentType: p.contentType })) }));
}

/** Which server a claim is on (so the right admin is asked), or null. */
export async function serverOfClaim(ex: Db, claimId: string): Promise<string | null> {
  const [r] = await ex.select({ serverId: libraries.serverId }).from(ownershipClaims).innerJoin(titles, eq(ownershipClaims.titleId, titles.id)).innerJoin(libraries, eq(titles.libraryId, libraries.id)).where(eq(ownershipClaims.id, claimId)).limit(1);
  return r?.serverId ?? null;
}
