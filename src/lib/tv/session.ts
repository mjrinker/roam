/**
 * Gives the TV that is polling a normal Supabase session for the account that approved it. The server asks Supabase for a one-time
 * sign-in token for the account's email (an admin call that sends no email) and redeems it on the TV's own request, so the
 * session cookies land on the TV. The token works once; the account must have an email (guests have none and cannot pair).
 */
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export interface SessionDeps {
  admin?: Pick<ReturnType<typeof createSupabaseServiceRoleClient>["auth"]["admin"], "getUserById" | "generateLink">;
  signInWithToken?: (tokenHash: string) => Promise<{ error: { message: string } | null }>;
}

export type MintResult = { ok: true } | { ok: false; reason: "no_email" | "failed" };

export async function mintTvSession(accountId: string, deps: SessionDeps = {}): Promise<MintResult> {
  const admin = deps.admin ?? createSupabaseServiceRoleClient().auth.admin;
  const user = await admin.getUserById(accountId);
  const email = user.data.user?.email;
  if (user.error || !email) return { ok: false, reason: "no_email" };

  const link = await admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return { ok: false, reason: "failed" };

  const redeem =
    deps.signInWithToken ??
    (async (hash: string) => {
      const supabase = await createSupabaseServerClient();
      return supabase.auth.verifyOtp({ type: "magiclink", token_hash: hash });
    });
  const { error } = await redeem(tokenHash);
  return error ? { ok: false, reason: "failed" } : { ok: true };
}
