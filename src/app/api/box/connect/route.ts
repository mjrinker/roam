import { NextResponse } from "next/server";
import { BoxOAuth, OAuthConfig } from "box-node-sdk";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { signBoxOAuthState } from "@/lib/storage/box-oauth-state";

/** Kicks off the Box OAuth handshake for a server. Only that server's admin can start it. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const member = await getCurrentServerAdmin(serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const auth = new BoxOAuth({
    config: new OAuthConfig({
      clientId: process.env.BOX_CLIENT_ID!,
      clientSecret: process.env.BOX_CLIENT_SECRET!,
    }),
  });

  const state = signBoxOAuthState(serverId, member.profile.id);
  const authorizeUrl = auth.getAuthorizeUrl({
    redirectUri: `${origin}/api/box/callback`,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}
