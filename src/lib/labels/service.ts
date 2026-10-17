/**
 * A profile's labels: making, renaming and deleting them, and putting titles under them. Everything is scoped to the profile's viewer id, which
 * always comes from the session; whether the profile may see a title is checked by the caller before a title is labelled (see the routes).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { labelItems, labels } from "@/lib/db/schema";
import { checkLabelName, labelNameKey, MAX_LABELS } from "./names";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface LabelRow {
  id: string;
  name: string;
  /** How many titles carry it. */
  count: number;
}
export type LabelResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

/** The profile's labels, A to Z, with how many titles each has. */
export async function listLabels(ex: Db, viewerId: string): Promise<LabelRow[]> {
  const rows = await ex
    .select({ id: labels.id, name: labels.name, count: sql<number>`(SELECT count(*)::int FROM label_items li WHERE li.label_id = ${labels.id})` })
    .from(labels)
    .where(eq(labels.viewerId, viewerId))
    .orderBy(asc(labels.nameKey));
  return rows;
}

export async function createLabel(ex: Db, viewerId: string, rawName: string): Promise<LabelResult<LabelRow>> {
  const checked = checkLabelName(rawName);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const key = labelNameKey(checked.name);
  const [existing] = await ex.select({ id: labels.id }).from(labels).where(and(eq(labels.viewerId, viewerId), eq(labels.nameKey, key)));
  if (existing) return { ok: false, status: 409, error: "You already have a label with that name." };
  const [{ n }] = await ex.select({ n: sql<number>`count(*)::int` }).from(labels).where(eq(labels.viewerId, viewerId));
  if (n >= MAX_LABELS) return { ok: false, status: 400, error: `You can have up to ${MAX_LABELS} labels.` };
  const [row] = await ex.insert(labels).values({ viewerId, name: checked.name, nameKey: key }).onConflictDoNothing().returning({ id: labels.id, name: labels.name });
  if (!row) return { ok: false, status: 409, error: "You already have a label with that name." };
  return { ok: true, value: { ...row, count: 0 } };
}

export async function renameLabel(ex: Db, viewerId: string, labelId: string, rawName: string): Promise<LabelResult<{ id: string; name: string }>> {
  const checked = checkLabelName(rawName);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const [own] = await ex.select({ id: labels.id }).from(labels).where(and(eq(labels.id, labelId), eq(labels.viewerId, viewerId)));
  if (!own) return { ok: false, status: 404, error: "Not found" };
  const key = labelNameKey(checked.name);
  const [clash] = await ex.select({ id: labels.id }).from(labels).where(and(eq(labels.viewerId, viewerId), eq(labels.nameKey, key)));
  if (clash && clash.id !== labelId) return { ok: false, status: 409, error: "You already have a label with that name." };
  await ex.update(labels).set({ name: checked.name, nameKey: key }).where(eq(labels.id, labelId));
  return { ok: true, value: { id: labelId, name: checked.name } };
}

/** Deletes a label of this profile (the titles keep everything else). False when it isn't theirs or doesn't exist. */
export async function deleteLabel(ex: Db, viewerId: string, labelId: string): Promise<boolean> {
  const gone = await ex.delete(labels).where(and(eq(labels.id, labelId), eq(labels.viewerId, viewerId))).returning({ id: labels.id });
  return gone.length > 0;
}

/** Puts a title under one of the profile's labels, or takes it off. False when the label isn't the profile's. */
export async function setTitleLabel(ex: Db, viewerId: string, labelId: string, titleId: string, on: boolean): Promise<boolean> {
  const [own] = await ex.select({ id: labels.id }).from(labels).where(and(eq(labels.id, labelId), eq(labels.viewerId, viewerId)));
  if (!own) return false;
  if (on) await ex.insert(labelItems).values({ labelId, titleId }).onConflictDoNothing();
  else await ex.delete(labelItems).where(and(eq(labelItems.labelId, labelId), eq(labelItems.titleId, titleId)));
  return true;
}

/** The profile's labels with whether each is on this title (for the Labels menu). */
export async function labelsForTitle(ex: Db, viewerId: string, titleId: string): Promise<(LabelRow & { has: boolean })[]> {
  const rows = await ex
    .select({
      id: labels.id,
      name: labels.name,
      count: sql<number>`(SELECT count(*)::int FROM label_items li WHERE li.label_id = ${labels.id})`,
      has: sql<boolean>`EXISTS (SELECT 1 FROM label_items li WHERE li.label_id = ${labels.id} AND li.title_id = ${titleId})`,
    })
    .from(labels)
    .where(eq(labels.viewerId, viewerId))
    .orderBy(asc(labels.nameKey));
  return rows;
}

/** Which of the profile's labels each of these titles carries (titles with none are not in the map). */
export async function labelIdsByTitle(ex: Db, viewerId: string, titleIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (titleIds.length === 0) return out;
  const rows = await ex
    .select({ titleId: labelItems.titleId, labelId: labelItems.labelId })
    .from(labelItems)
    .innerJoin(labels, eq(labels.id, labelItems.labelId))
    .where(and(eq(labels.viewerId, viewerId), inArray(labelItems.titleId, titleIds)));
  for (const r of rows) out.set(r.titleId, [...(out.get(r.titleId) ?? []), r.labelId]);
  return out;
}
