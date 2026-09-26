import { NextResponse } from "next/server";
import { BoxOAuth, OAuthConfig } from "box-node-sdk";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { verifyBoxOAuthState } from "@/lib/storage/box-oauth-state";
import { DbTokenStorage } from "@/lib/storage/box-token-storage";

/**
 * Box redirects here after the user approves/denies the consent screen.
 * The `state` param's signature and age are checked, and then — this is
 * the part that actually matters for CSRF/session-swap safety — the
 * payload's claimed profileId/serverId are re-checked against the LIVE
 * session, not just trusted because the signature is valid.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const oauthError = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!state) {
    return NextResponse.redirect(`${origin}/servers?error=box-connect-failed`);
  }

  const payload = verifyBoxOAuthState(state);
  if (!payload) {
    return NextResponse.redirect(`${origin}/servers?error=box-connect-failed`);
  }

  const member = await getCurrentServerAdmin(payload.serverId);
  if (!member || member.profile.id !== payload.profileId) {
    return NextResponse.redirect(`${origin}/servers?error=box-connect-failed`);
  }

  if (oauthError === "access_denied") {
    return NextResponse.redirect(
      `${origin}/s/${payload.serverId}/admin?error=box-connect-cancelled`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/s/${payload.serverId}/admin?error=box-connect-failed`
    );
  }

  try {
    const tokenStorage = new DbTokenStorage(payload.serverId);
    const auth = new BoxOAuth({
      config: new OAuthConfig({
        clientId: process.env.BOX_CLIENT_ID!,
        clientSecret: process.env.BOX_CLIENT_SECRET!,
        tokenStorage,
      }),
    });
    const token = await auth.getTokensAuthorizationCodeGrant(code);
    // Explicit, rather than relying solely on the SDK's own internal
    // persistence — store() is a public method and idempotent either way.
    await tokenStorage.store(token);
  } catch {
    return NextResponse.redirect(
      `${origin}/s/${payload.serverId}/admin?error=box-connect-failed`
    );
  }

  return NextResponse.redirect(`${origin}/s/${payload.serverId}/admin`);
}
