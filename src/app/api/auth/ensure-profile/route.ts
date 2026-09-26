import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { acceptInvite, ensureProfile } from "@/lib/auth/invites";
import { resolveLandingPath } from "@/lib/auth/servers";

const bodySchema = z.object({ inviteToken: z.string().optional() });

/**
 * Called by the client immediately after any successful Supabase sign-in
 * that doesn't go through a redirect (password sign-in/sign-up) to bind
 * the auth user to a profile and, if an invite token was carried along,
 * redeem it. Sign-in is open — this always succeeds at creating the
 * profile; invite redemption failing is reported separately and doesn't
 * undo the sign-in.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const inviteToken = parsed.success ? parsed.data.inviteToken : undefined;

  const profile = await ensureProfile(user.id, user.email);

  if (inviteToken) {
    const result = await acceptInvite(inviteToken, profile);
    if (result.ok) {
      return NextResponse.json({ redirectTo: `/s/${result.serverId}/library` });
    }
    return NextResponse.json({
      redirectTo: "/servers",
      error: result.reason === "email_mismatch" ? "invite-email-mismatch" : "invite-not-found",
    });
  }

  const redirectTo = await resolveLandingPath(profile.id);
  return NextResponse.json({ redirectTo });
}
