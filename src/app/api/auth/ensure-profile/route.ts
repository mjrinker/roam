import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { acceptInvite, ensureProfileWithStatus } from "@/lib/auth/invites";
import { acceptJoin } from "@/lib/auth/join";
import { scheduleGuestCleanup } from "@/lib/auth/guest-cleanup";
import { resolveLandingPath } from "@/lib/auth/servers";

const bodySchema = z.object({ inviteToken: z.string().max(200).optional(), joinToken: z.string().max(200).optional() });

/**
 * Called by the client immediately after any successful Supabase sign-in
 * that doesn't go through a redirect (password sign-in/sign-up, or an anonymous guest) to bind
 * the auth user to a profile and, if an invite or open join link token was carried along,
 * redeem it. Sign-in is open — this always succeeds at creating the
 * profile; redemption failing is reported separately and doesn't
 * undo the sign-in. Whether the visitor is a guest comes from the verified session, never from the request.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const guest = user?.is_anonymous === true;
  if (!user || (!guest && !user.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const inviteToken = parsed.success ? parsed.data.inviteToken : undefined;
  const joinToken = parsed.success ? parsed.data.joinToken : undefined;

  const { profile, created } = await ensureProfileWithStatus(user.id, user.email ?? null, { guest });

  if (joinToken) {
    // Always lands in the server's library (never on a path taken from the request).
    const result = await acceptJoin(joinToken, profile, { hide: guest || created, guest });
    if (result.ok) {
      scheduleGuestCleanup();
      return NextResponse.json({ redirectTo: `/s/${result.serverId}/library` });
    }
    return NextResponse.json({ redirectTo: "/servers", error: result.reason === "rate_limited" ? "join-rate-limited" : "join-not-found" });
  }

  // A guest only exists to be let into a demo; with no link they have nowhere to go.
  if (guest) return NextResponse.json({ redirectTo: "/servers" });

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
