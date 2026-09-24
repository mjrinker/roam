import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, profiles } from "@/lib/db/schema";

const INVITE_TTL_DAYS = 7;

export async function createInvite(
  email: string,
  role: "admin" | "viewer",
  invitedBy: string
) {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [invite] = await db
    .insert(invites)
    .values({ email: email.toLowerCase(), role, token, invitedBy, expiresAt })
    .returning();

  return invite;
}

/**
 * Called right after a user authenticates with Supabase for the first time.
 * The server is invite-only: a brand-new auth user only gets a `profiles`
 * row (and therefore app access) if a matching, unexpired, unaccepted
 * invite exists for their email. Returns the profile, or null if this user
 * was never invited (caller should sign them out).
 */
export async function ensureProfileFromInvite(userId: string, email: string) {
  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (existing) return existing;

  const normalizedEmail = email.toLowerCase();
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, normalizedEmail),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!invite) return null;

  const [profile] = await db
    .insert(profiles)
    .values({ id: userId, email: normalizedEmail, role: invite.role })
    .onConflictDoNothing({ target: profiles.id })
    .returning();

  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));

  return profile ?? (await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
}
