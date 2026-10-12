import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { onedriveAuthorizeUrl } from "@/lib/storage/onedrive";
import { signBoxOAuthState } from "@/lib/storage/box-oauth-state";

/** Starts the OneDrive sign-in for a server: a new connection (`connectionId=new`), or signing in again to an existing one. Only the server's admin. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  if (!serverId) return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  const member = await getCurrentServerAdmin(serverId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const requested = searchParams.get("connectionId");
  const label = searchParams.get("label")?.trim().slice(0, 60) || undefined;
  const connectionId = !requested || requested === "new" ? randomUUID() : requested;
  const state = signBoxOAuthState(serverId, member.profile.id, { connectionId, label });
  return NextResponse.redirect(onedriveAuthorizeUrl(`${origin}/api/onedrive/callback`, state));
}
