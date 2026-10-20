/**
 * Bug reports and feature requests. Anyone signed in (not a limited profile) can send one; a feature request goes on a public board that
 * everyone can vote and comment on, unless its author keeps it private; a bug is private to its author and the platform admin until the admin
 * publishes it. The platform admin triages (status, visibility, duplicates), replies as "Roam team", and a GitHub issue can be kept in step.
 * Authors are never named to anyone but the platform admin ("You" on your own, nothing on others').
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { feedbackComments, feedbackItems, feedbackVotes, profiles } from "@/lib/db/schema";
import { createIssue, setIssueState, type GithubConfig } from "@/lib/feedback/github";
import { cleanDiagnostics, cleanLine, cleanText, defaultVisibility, FEEDBACK_KINDS, FEEDBACK_STATUSES, MAX_BODY, MAX_COMMENT, MAX_TITLE, MIN_TITLE, type Diagnostics, type FeedbackKind, type FeedbackStatus, type FeedbackVisibility } from "@/lib/feedback/rules";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface FeedbackView {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  status: FeedbackStatus;
  visibility: FeedbackVisibility;
  votes: number;
  iVoted: boolean;
  mine: boolean;
  comments: number;
  duplicateOf: string | null;
  createdAt: string;
  /** Only for the platform admin: */
  operator?: { authorEmail: string | null; diagnostics: Diagnostics | null; githubIssueNumber: number | null; githubIssueUrl: string | null; githubError: string | null; serverId: string | null };
}

export interface CommentView {
  id: string;
  body: string;
  official: boolean;
  mine: boolean;
  createdAt: string;
}

export interface Who {
  accountId: string;
  /** A platform admin sees and may do everything. */
  operator: boolean;
}

const COUNTS = {
  // The outer id is spelled out: drizzle leaves a column of the only table in a select unqualified, which inside a subquery would mean the subquery's own.
  votes: sql<number>`(SELECT count(*)::int FROM ${feedbackVotes} v WHERE v.item_id = feedback_items.id)`,
  comments: sql<number>`(SELECT count(*)::int FROM ${feedbackComments} c WHERE c.item_id = feedback_items.id)`,
};

async function toViews(ex: Db, rows: (typeof feedbackItems.$inferSelect & { votes: number; comments: number })[], who: Who): Promise<FeedbackView[]> {
  if (rows.length === 0) return [];
  const mine = new Set((await ex.select({ id: feedbackVotes.itemId }).from(feedbackVotes).where(and(eq(feedbackVotes.accountId, who.accountId), inArray(feedbackVotes.itemId, rows.map((r) => r.id))))).map((v) => v.id));
  const emails = who.operator ? new Map((await ex.select({ id: profiles.id, email: profiles.email }).from(profiles).where(inArray(profiles.id, [...new Set(rows.flatMap((r) => (r.authorId ? [r.authorId] : [])))]))).map((p) => [p.id, p.email])) : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    status: r.status,
    visibility: r.visibility,
    votes: r.votes,
    iVoted: mine.has(r.id),
    mine: r.authorId === who.accountId,
    comments: r.comments,
    duplicateOf: r.duplicateOf,
    createdAt: r.createdAt.toISOString(),
    ...(who.operator ? { operator: { authorEmail: r.authorId ? emails.get(r.authorId) ?? null : null, diagnostics: r.diagnostics, githubIssueNumber: r.githubIssueNumber, githubIssueUrl: r.githubIssueUrl, githubError: r.githubError, serverId: r.serverId } } : {}),
  }));
}

const selectItems = (ex: Db) => ex.select({ ...feedbackItemsColumns(), votes: COUNTS.votes, comments: COUNTS.comments }).from(feedbackItems);
const feedbackItemsColumns = () => ({
  id: feedbackItems.id,
  kind: feedbackItems.kind,
  title: feedbackItems.title,
  body: feedbackItems.body,
  status: feedbackItems.status,
  visibility: feedbackItems.visibility,
  authorId: feedbackItems.authorId,
  serverId: feedbackItems.serverId,
  diagnostics: feedbackItems.diagnostics,
  duplicateOf: feedbackItems.duplicateOf,
  githubIssueNumber: feedbackItems.githubIssueNumber,
  githubIssueUrl: feedbackItems.githubIssueUrl,
  githubError: feedbackItems.githubError,
  createdAt: feedbackItems.createdAt,
  updatedAt: feedbackItems.updatedAt,
});

export type SubmitInput = { authorId: string; serverId: string | null; kind: unknown; title: unknown; body: unknown; keepPrivate?: unknown; diagnostics?: unknown };
export type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404; error: string };

export async function submitFeedback(ex: Db, input: SubmitInput): Promise<Result<{ id: string; visibility: FeedbackVisibility }>> {
  const kind = (FEEDBACK_KINDS as readonly unknown[]).includes(input.kind) ? (input.kind as FeedbackKind) : null;
  if (!kind) return { ok: false, status: 400, error: "Say whether this is a bug or a feature request." };
  const title = cleanLine(input.title, MAX_TITLE);
  if (title.length < MIN_TITLE) return { ok: false, status: 400, error: "Give it a short title." };
  const body = cleanText(input.body, MAX_BODY);
  if (body.length < 10) return { ok: false, status: 400, error: kind === "bug" ? "Say what happened and what you expected." : "Say a little about what you would like." };
  const visibility = defaultVisibility(kind, input.keepPrivate === true);
  const [row] = await ex
    .insert(feedbackItems)
    .values({ kind, title, body, visibility, authorId: input.authorId, serverId: input.serverId, diagnostics: cleanDiagnostics(input.diagnostics) })
    .returning({ id: feedbackItems.id, visibility: feedbackItems.visibility });
  // Whoever asked for a feature wants it.
  if (row.visibility === "public") await ex.insert(feedbackVotes).values({ itemId: row.id, accountId: input.authorId }).onConflictDoNothing();
  return { ok: true, value: row };
}

export type BoardOptions = { kind?: FeedbackKind | null; q?: string | null; sort?: "top" | "new"; status?: FeedbackStatus | "open" | null };

/** The public items: most voted first (or newest), finished and declined ones after the open ones. */
export async function listBoard(ex: Db, who: Who, opts: BoardOptions = {}): Promise<FeedbackView[]> {
  const conds: (SQL | undefined)[] = [eq(feedbackItems.visibility, "public")];
  if (opts.kind) conds.push(eq(feedbackItems.kind, opts.kind));
  if (opts.status === "open") conds.push(inArray(feedbackItems.status, ["new", "planned", "in_progress"]));
  else if (opts.status) conds.push(eq(feedbackItems.status, opts.status));
  const q = cleanLine(opts.q, 60);
  if (q) conds.push(or(ilike(feedbackItems.title, `%${escapeLike(q)}%`), ilike(feedbackItems.body, `%${escapeLike(q)}%`)));
  const closed = sql`CASE WHEN ${feedbackItems.status} IN ('done', 'declined', 'duplicate') THEN 1 ELSE 0 END`;
  const rows = await selectItems(ex)
    .where(and(...conds))
    .orderBy(closed, ...(opts.sort === "new" ? [desc(feedbackItems.createdAt)] : [desc(COUNTS.votes), desc(feedbackItems.createdAt)]))
    .limit(300);
  return toViews(ex, rows, who);
}

/** What this account has sent, newest first, private ones included. */
export async function listMine(ex: Db, who: Who): Promise<FeedbackView[]> {
  const rows = await selectItems(ex).where(eq(feedbackItems.authorId, who.accountId)).orderBy(desc(feedbackItems.createdAt)).limit(200);
  return toViews(ex, rows, who);
}

/** Public requests that look like these words (for "has this been asked already?"), best first. */
export async function similarRequests(ex: Db, who: Who, text: string, kind: FeedbackKind | null): Promise<FeedbackView[]> {
  const words = [...new Set(cleanLine(text, 120).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !COMMON.has(w)))].slice(0, 6);
  if (words.length === 0) return [];
  const rows = await selectItems(ex)
    .where(and(eq(feedbackItems.visibility, "public"), kind ? eq(feedbackItems.kind, kind) : undefined, or(...words.flatMap((w) => [ilike(feedbackItems.title, `%${escapeLike(w)}%`), ilike(feedbackItems.body, `%${escapeLike(w)}%`)]))))
    .orderBy(desc(COUNTS.votes))
    .limit(5);
  return toViews(ex, rows, who);
}

/** Words too common to say two requests are alike. */
const COMMON = new Set(["would", "could", "should", "there", "their", "great", "please", "want", "like", "have", "with", "this", "that", "from", "about", "when", "what", "they", "been", "just", "also", "more", "some", "will", "make", "able", "love", "need"]);

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Whether this person may look at the item: it is public, or theirs, or they are the platform admin. */
const canSee = (item: { visibility: FeedbackVisibility; authorId: string | null }, who: Who) => item.visibility === "public" || item.authorId === who.accountId || who.operator;

export async function getItem(ex: Db, who: Who, id: string): Promise<{ item: FeedbackView; comments: CommentView[] } | null> {
  const [row] = await selectItems(ex).where(eq(feedbackItems.id, id)).limit(1);
  if (!row || !canSee(row, who)) return null;
  const [item] = await toViews(ex, [row], who);
  const comments = await ex.select().from(feedbackComments).where(eq(feedbackComments.itemId, id)).orderBy(asc(feedbackComments.createdAt)).limit(500);
  return { item, comments: comments.map((c) => ({ id: c.id, body: c.body, official: c.official, mine: c.authorId === who.accountId, createdAt: c.createdAt.toISOString() })) };
}

/** Votes can only be given to what is on the board. */
export async function setVote(ex: Db, who: Who, id: string, on: boolean): Promise<Result<{ votes: number }>> {
  const [item] = await ex.select({ visibility: feedbackItems.visibility }).from(feedbackItems).where(eq(feedbackItems.id, id)).limit(1);
  if (!item || item.visibility !== "public") return { ok: false, status: 404, error: "Not found" };
  if (on) await ex.insert(feedbackVotes).values({ itemId: id, accountId: who.accountId }).onConflictDoNothing();
  else await ex.delete(feedbackVotes).where(and(eq(feedbackVotes.itemId, id), eq(feedbackVotes.accountId, who.accountId)));
  const [count] = await ex.select({ n: sql<number>`count(*)::int` }).from(feedbackVotes).where(eq(feedbackVotes.itemId, id));
  return { ok: true, value: { votes: count.n } };
}

/** A comment on a public item, or on your own, or (the platform admin) on any, as "Roam team". */
export async function addComment(ex: Db, who: Who, id: string, body: unknown): Promise<Result<CommentView>> {
  const [item] = await ex.select({ visibility: feedbackItems.visibility, authorId: feedbackItems.authorId }).from(feedbackItems).where(eq(feedbackItems.id, id)).limit(1);
  if (!item || !canSee(item, who)) return { ok: false, status: 404, error: "Not found" };
  const text = cleanText(body, MAX_COMMENT);
  if (text.length < 1) return { ok: false, status: 400, error: "Write something first." };
  const [row] = await ex.insert(feedbackComments).values({ itemId: id, authorId: who.accountId, official: who.operator, body: text }).returning();
  await ex.update(feedbackItems).set({ updatedAt: new Date() }).where(eq(feedbackItems.id, id));
  return { ok: true, value: { id: row.id, body: row.body, official: row.official, mine: true, createdAt: row.createdAt.toISOString() } };
}

// ── The platform admin ───────────────────────────────────────────────────

export type InboxOptions = { kind?: FeedbackKind | null; status?: FeedbackStatus | "open" | null; visibility?: FeedbackVisibility | null; q?: string | null };

/** Everything, newest first (open ones before closed). */
export async function listInbox(ex: Db, who: Who, opts: InboxOptions = {}): Promise<FeedbackView[]> {
  const conds: (SQL | undefined)[] = [];
  if (opts.kind) conds.push(eq(feedbackItems.kind, opts.kind));
  if (opts.visibility) conds.push(eq(feedbackItems.visibility, opts.visibility));
  if (opts.status === "open") conds.push(inArray(feedbackItems.status, ["new", "planned", "in_progress"]));
  else if (opts.status) conds.push(eq(feedbackItems.status, opts.status));
  const q = cleanLine(opts.q, 60);
  if (q) conds.push(or(ilike(feedbackItems.title, `%${escapeLike(q)}%`), ilike(feedbackItems.body, `%${escapeLike(q)}%`)));
  const closed = sql`CASE WHEN ${feedbackItems.status} IN ('done', 'declined', 'duplicate') THEN 1 ELSE 0 END`;
  const rows = await selectItems(ex).where(and(...conds)).orderBy(closed, desc(feedbackItems.createdAt)).limit(500);
  return toViews(ex, rows, { ...who, operator: true });
}

export type Triage = { status?: unknown; visibility?: unknown; duplicateOf?: unknown };

/** Sets what the platform admin decided. Returns the new status (so a GitHub issue can follow). */
export async function triage(ex: Db, id: string, change: Triage): Promise<Result<{ status: FeedbackStatus }>> {
  const [item] = await ex.select({ status: feedbackItems.status }).from(feedbackItems).where(eq(feedbackItems.id, id)).limit(1);
  if (!item) return { ok: false, status: 404, error: "Not found" };
  const set: Partial<typeof feedbackItems.$inferInsert> = { updatedAt: new Date() };
  if (change.status !== undefined) {
    if (!(FEEDBACK_STATUSES as readonly unknown[]).includes(change.status)) return { ok: false, status: 400, error: "That isn't a status." };
    set.status = change.status as FeedbackStatus;
  }
  if (change.visibility !== undefined) {
    if (change.visibility !== "public" && change.visibility !== "private") return { ok: false, status: 400, error: "Public or private." };
    set.visibility = change.visibility;
  }
  if (change.duplicateOf !== undefined) {
    if (change.duplicateOf === null) set.duplicateOf = null;
    else {
      const [other] = typeof change.duplicateOf === "string" && change.duplicateOf !== id ? await ex.select({ id: feedbackItems.id }).from(feedbackItems).where(eq(feedbackItems.id, change.duplicateOf)).limit(1) : [];
      if (!other) return { ok: false, status: 400, error: "That isn't another report." };
      set.duplicateOf = other.id;
      // Marking something as a duplicate says so, unless a status was chosen as well.
      if (set.status === undefined) set.status = "duplicate";
    }
  }
  await ex.update(feedbackItems).set(set).where(eq(feedbackItems.id, id));
  return { ok: true, value: { status: set.status ?? item.status } };
}

export async function deleteItem(ex: Db, id: string): Promise<boolean> {
  return (await ex.delete(feedbackItems).where(eq(feedbackItems.id, id)).returning({ id: feedbackItems.id })).length > 0;
}

export async function deleteComment(ex: Db, itemId: string, commentId: string): Promise<boolean> {
  return (await ex.delete(feedbackComments).where(and(eq(feedbackComments.id, commentId), eq(feedbackComments.itemId, itemId))).returning({ id: feedbackComments.id })).length > 0;
}

// ── GitHub ───────────────────────────────────────────────────────────────

/** Makes the item's GitHub issue exist (for a new report) or match its status (for a changed one); what went wrong is kept on the item. */
export async function syncGithub(ex: Db, id: string, cfg: GithubConfig, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  const [item] = await ex.select().from(feedbackItems).where(eq(feedbackItems.id, id)).limit(1);
  if (!item) return { ok: false, error: "Not found" };
  if (item.githubIssueNumber === null) {
    const made = await createIssue(cfg, { kind: item.kind, title: item.title, body: item.body, diagnostics: item.diagnostics }, fetchImpl);
    if (!made.ok) {
      await ex.update(feedbackItems).set({ githubError: made.error }).where(eq(feedbackItems.id, id));
      return { ok: false, error: made.error };
    }
    await ex.update(feedbackItems).set({ githubIssueNumber: made.value.number, githubIssueUrl: made.value.url, githubError: null }).where(eq(feedbackItems.id, id));
    // A report that was already closed when it was filed (an admin triaged it first) is closed there too.
    if (item.status !== "new") return syncGithub(ex, id, cfg, fetchImpl);
    return { ok: true };
  }
  const set = await setIssueState(cfg, item.githubIssueNumber, item.status, fetchImpl);
  await ex.update(feedbackItems).set({ githubError: set.ok ? null : set.error }).where(eq(feedbackItems.id, id));
  return set.ok ? { ok: true } : { ok: false, error: set.error };
}
