import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { acceptInvite, ensureProfile } from "@/lib/auth/invites";
import { resolveLandingPath } from "@/lib/auth/servers";

/**
 * Landing point for magic-link and OAuth (Google) sign-in — Supabase
 * redirects here with a `?code=` to exchange for a session, and an
 * optional `?invite_token=` carried through from the sign-in form.
 *
 * Sign-in is open: ensureProfile always succeeds. Invite redemption is a
 * separate, independently-failable step from authentication succeeding —
 * an invalid/expired/email-mismatched invite doesn't sign the user out,
 * it just means they land on the servers hub instead of the invited
 * server, with an error to explain why.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const inviteToken = searchParams.get("invite_token");

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user?.email) {
      const profile = await ensureProfile(data.user.id, data.user.email);

      if (inviteToken) {
        const result = await acceptInvite(inviteToken, profile);
        if (result.ok) {
          return NextResponse.redirect(`${origin}/s/${result.serverId}/library`);
        }
        const errorCode =
          result.reason === "email_mismatch" ? "invite-email-mismatch" : "invite-not-found";
        return NextResponse.redirect(`${origin}/servers?error=${errorCode}`);
      }

      const landingPath = await resolveLandingPath(profile.id);
      return NextResponse.redirect(`${origin}${landingPath}`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth-failed`);
}
