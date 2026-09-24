import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfileFromInvite } from "@/lib/auth/invites";

/**
 * Landing point for magic-link and OAuth (Google) sign-in — Supabase
 * redirects here with a `?code=` to exchange for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user?.email) {
      const profile = await ensureProfileFromInvite(data.user.id, data.user.email);
      if (!profile) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/sign-in?error=not-invited`);
      }
      return NextResponse.redirect(`${origin}/library`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth-failed`);
}
