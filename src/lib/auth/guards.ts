import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { profiles as ProfilesTable } from "@/lib/db/schema";

export type Profile = typeof ProfilesTable.$inferSelect;

/**
 * Resolves the current session's profile row, or null if signed out.
 * Use in Server Components / Route Handlers.
 */
export async function getCurrentProfile(): Promise<Profile | null> {
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
}

/** Requires a signed-in profile, redirecting to /sign-in otherwise. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/sign-in");
  return profile;
}

/** Requires an admin profile, redirecting non-admins to the library. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "admin") redirect("/library");
  return profile;
}

/**
 * Route Handler variant: resolves the admin profile or null, with no
 * redirect side effect (a `redirect()` thrown outside page rendering is
 * just an uncaught error). Callers return their own 401/403 JSON response.
 */
export async function getCurrentAdminProfile(): Promise<Profile | null> {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") return null;
  return profile;
}
