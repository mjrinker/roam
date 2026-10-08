/**
 * The open join link: a server's admin can switch on a link that ANYONE may use, as often as they like, to
 * become a viewer of the server (the public demo uses it). It is only ever a viewer: it adds a membership with
 * DO NOTHING on conflict, so someone already a member (the admin included) keeps the role they have, and the
 * one-admin rule in the database stands behind that.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { profiles, serverMembers, servers, viewers } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

/** 24 random bytes as base64url: 32 characters. */
export const newJoinToken = () => randomBytes(24).toString("base64url");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export interface JoinTarget {
  serverId: string;
  serverName: string;
  isDemo: boolean;
}

/** The server an open link points at, or null for any token that isn't one (unknown, switched off, replaced, malformed): all alike. */
export async function getJoinTarget(token: string): Promise<JoinTarget | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  // Checked every time the link is used, not only when it was made: taking the permission away from an account
  // switches off every open link its servers have, at once.
  const [row] = await db
    .select({ serverId: servers.id, serverName: servers.name, isDemo: servers.isDemo })
    .from(servers)
    .innerJoin(profiles, eq(profiles.id, servers.ownerId))
    .where(and(eq(servers.joinToken, token), eq(profiles.canManageOpenLinks, true)))
    .limit(1);
  return row ?? null;
}

export type JoinResult = { ok: true; serverId: string; isDemo: boolean } | { ok: false; reason: "not_found" | "rate_limited" };

/**
 * Joins `account` to the server behind `token` as a viewer. `hide` makes a brand-new account's profiles
 * invisible to other members from the first moment (only used on demo servers, and only for accounts that
 * were just created, so nobody's existing visibility is changed).
 */
export async function acceptJoin(token: string, account: { id: string }, opts: { hide?: boolean; guest?: boolean } = {}): Promise<JoinResult> {
  // Limited per account; a fresh guest has a fresh budget, so the demo's own daily limits are what bound the cost.
  if (!(await checkRateLimit(account.id, "join_server", 20, 3600))) return { ok: false, reason: "rate_limited" };
  const target = await getJoinTarget(token);
  if (!target) return { ok: false, reason: "not_found" };
  // One-click guest entry exists for public demos only; a family server's open link needs a real sign-in.
  if (opts.guest && !target.isDemo) return { ok: false, reason: "not_found" };

  // Hidden first, so a newcomer is never a visible member, even for a moment (or for good if this step failed).
  if (opts.hide && target.isDemo) await db.update(viewers).set({ visibleOnServer: false }).where(eq(viewers.accountId, account.id));
  await db
    .insert(serverMembers)
    .values({ serverId: target.serverId, profileId: account.id, role: "viewer" })
    .onConflictDoNothing({ target: [serverMembers.serverId, serverMembers.profileId] });
  return { ok: true, serverId: target.serverId, isDemo: target.isDemo };
}

export interface JoinLinkChange {
  /** Switch the open link on (creating it) or off. */
  enabled?: boolean;
  /** Replace the link, so the old one stops working. */
  rotate?: boolean;
  /** Mark this as a public demo server (or not). */
  demo?: boolean;
}

/** Applies an admin's change to a server's open link and demo flag. The caller has already checked the actor administers the server. */
export async function setJoinLink(serverId: string, change: JoinLinkChange): Promise<{ joinToken: string | null; isDemo: boolean } | null> {
  return db.transaction(async (tx) => {
    const [server] = await tx.select({ joinToken: servers.joinToken, isDemo: servers.isDemo }).from(servers).where(eq(servers.id, serverId)).for("update");
    if (!server) return null;
    let joinToken = server.joinToken;
    if (change.enabled === false) joinToken = null;
    else if (change.enabled === true && !joinToken) joinToken = newJoinToken();
    if (change.rotate && joinToken) joinToken = newJoinToken();
    const isDemo = change.demo ?? server.isDemo;
    await tx.update(servers).set({ joinToken, isDemo }).where(eq(servers.id, serverId));
    return { joinToken, isDemo };
  });
}

