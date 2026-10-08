import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { profiles, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { profiles as ProfilesTable, Viewer } from "@/lib/db/schema";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { touchGuest } from "@/lib/auth/guests";

export type Profile = typeof ProfilesTable.$inferSelect;
export type ServerRole = "admin" | "viewer";
export interface ServerMembership {
  /** The signed-in ACCOUNT (the `profiles` table). */
  profile: Profile;
  /** The person using it right now (the `viewers` table); what watch history and restrictions attach to. */
  viewer: Viewer;
  role: ServerRole;
}

/**
 * Resolves the current session's profile row, or null if signed out.
 * Use in Server Components / Route Handlers.
 */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  return profile ?? null;
});

/** Requires a signed-in profile, redirecting to /sign-in otherwise. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/sign-in");
  return profile;
}

/**
 * Requires a selected profile (the "Who's watching?" choice). Signed out goes
 * to sign-in; signed in with no selection goes to the chooser.
 */
export async function requireViewer(): Promise<{ account: Profile; viewer: Viewer }> {
  const resolved = await getCurrentViewer();
  if (!resolved) redirect("/sign-in");
  if (!resolved.viewer) redirect("/profiles");
  return { account: resolved.account, viewer: resolved.viewer };
}

/** Looks up a profile's role on a given server, or null if not a member. */
export async function getServerMembership(
  profileId: string,
  serverId: string
): Promise<{ role: ServerRole } | null> {
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))
    )
    .limit(1);
  return membership ?? null;
}

/** Requires the signed-in profile to be a member of `serverId`, redirecting to /servers otherwise. */
export async function requireServerMember(serverId: string): Promise<ServerMembership> {
  const { account: profile, viewer } = await requireViewer();
  await touchGuest(profile); // a guest's inactivity clock (a no-op for everyone else)
  const membership = await getServerMembership(profile.id, serverId);
  if (!membership) redirect("/servers");
  return { profile, viewer, role: membership.role };
}

/**
 * Requires the signed-in profile to be an admin of `serverId`, redirecting
 * non-admins into that server's library. Also requires a non-"limited"
 * profile role — admin pages list every title regardless of rating
 * (unmatched titles, match dialogs), so a kid profile must never reach them
 * even on an account that is a server admin. (This "admin" is the SERVER
 * role from server_members, unrelated to the profile's owner/admin/limited
 * role in lib/content/roles — a coincidence of naming.)
 */
export async function requireServerAdmin(serverId: string): Promise<ServerMembership> {
  const result = await requireServerMember(serverId);
  if (result.role !== "admin" || result.viewer.role === "limited") redirect(`/s/${serverId}/library`);
  return result;
}

/**
 * Route Handler variant: resolves the member/role for `serverId`, or null,
 * with no redirect side effect (a `redirect()` thrown outside page
 * rendering is just an uncaught error). Callers return their own
 * 401/403 JSON response.
 */
export async function getCurrentServerMember(
  serverId: string
): Promise<ServerMembership | null> {
  const resolved = await getCurrentViewer();
  if (!resolved?.viewer) return null;
  const membership = await getServerMembership(resolved.account.id, serverId);
  if (!membership) return null;
  return { profile: resolved.account, viewer: resolved.viewer, role: membership.role };
}

/** Route Handler variant of requireServerAdmin — returns null instead of redirecting. */
export async function getCurrentServerAdmin(
  serverId: string
): Promise<ServerMembership | null> {
  const result = await getCurrentServerMember(serverId);
  if (!result || result.role !== "admin" || result.viewer.role === "limited") return null;
  return result;
}
