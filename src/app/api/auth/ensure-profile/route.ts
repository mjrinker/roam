import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfileFromInvite } from "@/lib/auth/invites";

/**
 * Called by the client immediately after any successful Supabase sign-in
 * (password, magic link landing, or OAuth callback) to bind the auth user
 * to an invited `profiles` row. If there's no matching invite, the session
 * is revoked — this server is invite-only, not open self-signup.
 */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await ensureProfileFromInvite(user.id, user.email);
  if (!profile) {
    await supabase.auth.signOut();
    return NextResponse.json(
      { error: "No invite found for this email" },
      { status: 403 }
    );
  }

  return NextResponse.json({ profile });
}
