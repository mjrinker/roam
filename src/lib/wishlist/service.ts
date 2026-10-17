/**
 * The server's shared wishlist. Every member sees every wish and who wants it (by household name, as each household lets it be shown);
 * anyone can add a wish or say they want one too; one household can say it will buy it; whoever asked, or the admin, can take a wish off.
 * Whether something is already on the server is only ever answered for what the asking profile may see.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, titles, wishlistItems, wishlistVotes } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { hasPlayableFile } from "@/lib/content/playable";
import { householdNames } from "@/lib/ownership/owners";
import { cleanPosterUrl, MAX_CREATOR, MAX_NOTE, MAX_OPEN_PER_HOUSEHOLD, MAX_OPEN_WISHES, MAX_OVERVIEW, MAX_TITLE, tidy, wishKey, WISH_KINDS, type WishKind } from "./rules";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type Scope = { actor: LibraryActor; viewer: AccessProfile; serverId: string };
export type WishStatus = "wanted" | "claimed" | "got";

export interface WishView {
  id: string;
  kind: WishKind;
  title: string;
  year: number | null;
  creator: string | null;
  tmdbId: number | null;
  posterUrl: string | null;
  overview: string | null;
  note: string | null;
  status: WishStatus;
  /** How many households want it. */
  wants: number;
  /** The names of the households that want it (those that let their name be shown; others count in `wants` only). */
  wantedBy: string[];
  iWant: boolean;
  claimedByName: string | null;
  claimedByMe: boolean;
  /** Whether this household asked for it, so may take it off (the admin always may). */
  canRemove: boolean;
  /** A movie or show that is already on the server (that this profile may see). */
  onServer: { titleId: string } | null;
  createdAt: string;
}

export type WishResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; error: string; titleId?: string };

/** For movies and shows with a TMDB id: the title on this server that is the same thing, when this profile may see it. */
export async function onServerFor(ex: Db, s: Scope, wishes: { kind: WishKind; tmdbId: number | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(wishes.filter((w) => w.tmdbId !== null && (w.kind === "movie" || w.kind === "show")).map((w) => w.tmdbId as number))];
  if (ids.length === 0) return new Map();
  const rows = await ex
    .select({ id: titles.id, tmdbId: titles.tmdbId, kind: titles.kind })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(libraries.serverId, s.serverId), inArray(titles.tmdbId, ids), inArray(titles.kind, ["movie", "show"]), libraryVisible(ex, s.actor), contentFilter(s.viewer, titles.ratingAges), hasPlayableFile(titles.id, titles.kind)));
  return new Map(rows.map((r) => [`${r.kind}:${r.tmdbId}`, r.id]));
}

/** The wishes, most wanted first (then newest); those already got come last. */
export async function listWishes(ex: Db, s: Scope & { accountId: string; isAdmin: boolean }): Promise<WishView[]> {
  const rows = await ex.select().from(wishlistItems).where(eq(wishlistItems.serverId, s.serverId)).orderBy(desc(wishlistItems.createdAt));
  if (rows.length === 0) return [];
  const votes = await ex.select({ wishId: wishlistVotes.wishId, accountId: wishlistVotes.accountId }).from(wishlistVotes).where(inArray(wishlistVotes.wishId, rows.map((r) => r.id)));
  const people = [...new Set([...votes.map((v) => v.accountId), ...rows.flatMap((r) => (r.claimedBy ? [r.claimedBy] : []))])];
  const names = await householdNames(ex, people, false);
  const have = await onServerFor(ex, s, rows);
  const byWish = new Map<string, string[]>();
  for (const v of votes) byWish.set(v.wishId, [...(byWish.get(v.wishId) ?? []), v.accountId]);
  const out: WishView[] = rows.map((r) => {
    const voters = byWish.get(r.id) ?? [];
    const shown = voters.map((a) => names.get(a)).filter((n): n is string => !!n && n !== "A household");
    const titleId = r.tmdbId !== null ? have.get(`${r.kind}:${r.tmdbId}`) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      year: r.year,
      creator: r.creator,
      tmdbId: r.tmdbId,
      posterUrl: r.posterUrl,
      overview: r.overview,
      note: r.note,
      status: r.status,
      wants: voters.length,
      wantedBy: [...new Set(shown)].sort((a, b) => a.localeCompare(b)),
      iWant: voters.includes(s.accountId),
      claimedByName: r.claimedBy ? (names.get(r.claimedBy) ?? "A household") : null,
      claimedByMe: r.claimedBy === s.accountId,
      canRemove: s.isAdmin || r.requestedBy === s.accountId,
      onServer: titleId ? { titleId } : null,
      createdAt: r.createdAt.toISOString(),
    };
  });
  const rank = (w: WishView) => (w.status === "got" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.wants - a.wants || b.createdAt.localeCompare(a.createdAt));
}

export interface NewWish {
  kind: string;
  title: unknown;
  year?: unknown;
  creator?: unknown;
  tmdbId?: unknown;
  posterUrl?: unknown;
  overview?: unknown;
  note?: unknown;
}

/**
 * Adds a wish for a household. If the same thing is already listed this household just joins it (a vote). Refuses a movie or show that is
 * already on the server for this profile to see, and a list that is full.
 */
export async function addWish(ex: Db, s: Scope & { accountId: string }, input: NewWish): Promise<WishResult<{ id: string; joined: boolean }>> {
  const kind = input.kind as WishKind;
  if (!(WISH_KINDS as readonly string[]).includes(kind)) return { ok: false, status: 400, error: "Choose what kind of thing it is." };
  const title = tidy(input.title, MAX_TITLE);
  if (!title) return { ok: false, status: 400, error: "Give it a title." };
  const key = wishKey(title);
  if (!key) return { ok: false, status: 400, error: "Give it a title." };
  const year = typeof input.year === "number" && Number.isInteger(input.year) && input.year >= 1800 && input.year <= 2200 ? input.year : null;
  const tmdbId = (kind === "movie" || kind === "show") && typeof input.tmdbId === "number" && Number.isInteger(input.tmdbId) && input.tmdbId > 0 ? input.tmdbId : null;

  if (tmdbId !== null) {
    const have = (await onServerFor(ex, s, [{ kind, tmdbId }])).get(`${kind}:${tmdbId}`);
    if (have) return { ok: false, status: 409, error: "That is already on this server.", titleId: have };
  }
  const [existing] = await ex.select({ id: wishlistItems.id, status: wishlistItems.status }).from(wishlistItems).where(and(eq(wishlistItems.serverId, s.serverId), eq(wishlistItems.kind, kind), eq(wishlistItems.titleKey, key), eq(wishlistItems.yearKey, year ?? 0)));
  if (existing) {
    await ex.insert(wishlistVotes).values({ wishId: existing.id, accountId: s.accountId }).onConflictDoNothing();
    if (existing.status === "got") await ex.update(wishlistItems).set({ status: "wanted", claimedBy: null, updatedAt: new Date() }).where(eq(wishlistItems.id, existing.id));
    return { ok: true, value: { id: existing.id, joined: true } };
  }
  const [{ open, mine }] = await ex
    .select({ open: sql<number>`count(*) FILTER (WHERE ${wishlistItems.status} <> 'got')::int`, mine: sql<number>`count(*) FILTER (WHERE ${wishlistItems.status} <> 'got' AND ${wishlistItems.requestedBy} = ${s.accountId})::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.serverId, s.serverId));
  if (open >= MAX_OPEN_WISHES) return { ok: false, status: 400, error: "The wishlist is full. Some of it needs to be got or taken off first." };
  if (mine >= MAX_OPEN_PER_HOUSEHOLD) return { ok: false, status: 400, error: `Your household has ${MAX_OPEN_PER_HOUSEHOLD} wishes open already.` };
  const [row] = await ex
    .insert(wishlistItems)
    .values({
      serverId: s.serverId,
      kind,
      title,
      titleKey: key,
      year,
      yearKey: year ?? 0,
      creator: tidy(input.creator, MAX_CREATOR),
      tmdbId,
      posterUrl: tmdbId !== null ? cleanPosterUrl(input.posterUrl) : null,
      overview: tidy(input.overview, MAX_OVERVIEW),
      note: tidy(input.note, MAX_NOTE),
      requestedBy: s.accountId,
    })
    .onConflictDoNothing()
    .returning({ id: wishlistItems.id });
  if (!row) return { ok: false, status: 409, error: "That is already on the wishlist." };
  await ex.insert(wishlistVotes).values({ wishId: row.id, accountId: s.accountId });
  return { ok: true, value: { id: row.id, joined: false } };
}

async function wishOn(ex: Db, serverId: string, id: string) {
  const [w] = await ex.select().from(wishlistItems).where(and(eq(wishlistItems.id, id), eq(wishlistItems.serverId, serverId)));
  return w ?? null;
}

/** "I want this too" (or not any more). The household that asked can't take its own want away while it is the only one wanting it: it removes the wish. */
export async function setWant(ex: Db, serverId: string, accountId: string, id: string, on: boolean): Promise<WishResult<{ wants: number }>> {
  const w = await wishOn(ex, serverId, id);
  if (!w) return { ok: false, status: 404, error: "Not found" };
  if (on) await ex.insert(wishlistVotes).values({ wishId: id, accountId }).onConflictDoNothing();
  else await ex.delete(wishlistVotes).where(and(eq(wishlistVotes.wishId, id), eq(wishlistVotes.accountId, accountId)));
  const [{ n }] = await ex.select({ n: sql<number>`count(*)::int` }).from(wishlistVotes).where(eq(wishlistVotes.wishId, id));
  if (n === 0) await ex.delete(wishlistItems).where(eq(wishlistItems.id, id)); // nobody wants it any more
  return { ok: true, value: { wants: n } };
}

/** "I'll buy this" / "not me after all" / "got it" / "wanted again". Taking and giving back are the claimer's; marking got is the claimer's or the admin's. */
export async function changeStatus(ex: Db, serverId: string, accountId: string, isAdmin: boolean, id: string, action: "claim" | "unclaim" | "got" | "reopen"): Promise<WishResult<{ status: WishStatus }>> {
  const w = await wishOn(ex, serverId, id);
  if (!w) return { ok: false, status: 404, error: "Not found" };
  const now = new Date();
  if (action === "claim") {
    if (w.status === "claimed" && w.claimedBy !== accountId) return { ok: false, status: 409, error: "Another household is already getting this." };
    if (w.status === "got") return { ok: false, status: 409, error: "It has been got already." };
    await ex.update(wishlistItems).set({ status: "claimed", claimedBy: accountId, updatedAt: now }).where(eq(wishlistItems.id, id));
    return { ok: true, value: { status: "claimed" } };
  }
  if (action === "unclaim") {
    if (w.status !== "claimed") return { ok: true, value: { status: w.status } };
    if (w.claimedBy !== accountId && !isAdmin) return { ok: false, status: 403, error: "Only the household getting it, or the admin, can change that." };
    await ex.update(wishlistItems).set({ status: "wanted", claimedBy: null, updatedAt: now }).where(eq(wishlistItems.id, id));
    return { ok: true, value: { status: "wanted" } };
  }
  if (action === "got") {
    if (w.status === "claimed" ? w.claimedBy !== accountId && !isAdmin : !isAdmin) return { ok: false, status: 403, error: "Only the household getting it, or the admin, can mark it as got." };
    await ex.update(wishlistItems).set({ status: "got", updatedAt: now }).where(eq(wishlistItems.id, id));
    return { ok: true, value: { status: "got" } };
  }
  if (!isAdmin && w.claimedBy !== accountId) return { ok: false, status: 403, error: "Only the admin can put it back on the list." };
  await ex.update(wishlistItems).set({ status: "wanted", claimedBy: null, updatedAt: now }).where(eq(wishlistItems.id, id));
  return { ok: true, value: { status: "wanted" } };
}

/** Takes a wish off the list: the household that asked, or the admin. */
export async function removeWish(ex: Db, serverId: string, accountId: string, isAdmin: boolean, id: string): Promise<WishResult<null>> {
  const w = await wishOn(ex, serverId, id);
  if (!w) return { ok: false, status: 404, error: "Not found" };
  if (!isAdmin && w.requestedBy !== accountId) return { ok: false, status: 403, error: "Only the household that asked for it, or the admin, can take it off." };
  await ex.delete(wishlistItems).where(eq(wishlistItems.id, id));
  return { ok: true, value: null };
}

/** Changes the note on a wish: the household that asked, or the admin. */
export async function setNote(ex: Db, serverId: string, accountId: string, isAdmin: boolean, id: string, note: unknown): Promise<WishResult<{ note: string | null }>> {
  const w = await wishOn(ex, serverId, id);
  if (!w) return { ok: false, status: 404, error: "Not found" };
  if (!isAdmin && w.requestedBy !== accountId) return { ok: false, status: 403, error: "Only the household that asked for it, or the admin, can change its note." };
  const value = tidy(note, MAX_NOTE);
  await ex.update(wishlistItems).set({ note: value, updatedAt: new Date() }).where(eq(wishlistItems.id, id));
  return { ok: true, value: { note: value } };
}

/** Looks up the server a wish belongs to (for routes that only have the wish's id). */
export async function serverOfWish(ex: Db, id: string): Promise<string | null> {
  const [w] = await ex.select({ serverId: wishlistItems.serverId }).from(wishlistItems).where(eq(wishlistItems.id, id));
  return w?.serverId ?? null;
}

