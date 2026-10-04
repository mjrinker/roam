import { randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, profiles, serverMembers } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { ensureDefaultViewer } from "@/lib/auth/viewer";

const INVITE_TTL_DAYS = 7;
const MAX_PENDING_INVITES_PER_SERVER = Number(
  process.env.MAX_PENDING_INVITES_PER_SERVER ?? 25
);

/**
 * Called right after a user authenticates with Supabase for the first
 * time. Sign-in is open — every authenticated user gets a bare profile
 * row unconditionally. This never rejects; access to any particular
 * server is a separate concern handled by server_members (see
 * acceptInvite and lib/auth/servers.ts).
 */
export async function ensureProfile(userId: string, email: string) {
  const normalizedEmail = email.toLowerCase();
  const [profile] = await db
    .insert(profiles)
    .values({ id: userId, email: normalizedEmail })
    .onConflictDoNothing({ target: profiles.id })
    .returning();

  const account =
    profile ??
    (await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
  // Every account starts with one profile of its own.
  await ensureDefaultViewer(account);
  return account;
}

export interface CreateInviteResult {
  invite: typeof invites.$inferSelect;
  error?: never;
}
export interface CreateInviteError {
  invite?: never;
  error: "rate_limited" | "too_many_pending";
}

/** Rate-limited (10/hour/inviter) and capped per-server (pending invites). */
export async function createInvite(
  email: string,
  serverId: string,
  invitedBy: string
): Promise<CreateInviteResult | CreateInviteError> {
  const withinLimit = await checkRateLimit(invitedBy, "create_invite", 10, 3600);
  if (!withinLimit) return { error: "rate_limited" };

  const normalizedEmail = email.toLowerCase();
  const now = new Date();

  const [existing] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.serverId, serverId),
        eq(invites.email, normalizedEmail),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now)
      )
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(invites)
      .set({
        invitedBy,
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      })
      .where(eq(invites.id, existing.id))
      .returning();
    return { invite: updated };
  }

  const [{ pendingCount }] = await db
    .select({ pendingCount: count() })
    .from(invites)
    .where(
      and(
        eq(invites.serverId, serverId),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now)
      )
    );
  if (pendingCount >= MAX_PENDING_INVITES_PER_SERVER) {
    return { error: "too_many_pending" };
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [invite] = await db
    .insert(invites)
    .values({ serverId, email: normalizedEmail, role: "viewer", token, invitedBy, expiresAt })
    .returning();

  return { invite };
}

export type AcceptInviteResult =
  | { ok: true; serverId: string }
  | { ok: false; reason: "not_found" | "email_mismatch" };

/**
 * Redeems an invite token for an already-authenticated profile. Grants a
 * server_members row (not a profiles row — those are created unconditionally
 * by ensureProfile now). Idempotent: re-accepting, or being re-invited at a
 * different role, both just work via onConflictDoUpdate.
 */
export async function acceptInvite(
  token: string,
  profile: { id: string; email: string }
): Promise<AcceptInviteResult> {
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!invite) return { ok: false, reason: "not_found" };

  if (invite.email.toLowerCase() !== profile.email.toLowerCase()) {
    return { ok: false, reason: "email_mismatch" };
  }

  // A server has exactly one admin (whoever created it), so an invite only ever makes a viewer, and
  // accepting one never changes the role of someone who's already a member.
  await db
    .insert(serverMembers)
    .values({ serverId: invite.serverId, profileId: profile.id, role: "viewer" })
    .onConflictDoNothing({ target: [serverMembers.serverId, serverMembers.profileId] });

  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));

  return { ok: true, serverId: invite.serverId };
}
