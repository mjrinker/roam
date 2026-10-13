import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { storageConnections } from "@/lib/db/schema";
import { verifyBoxOAuthState } from "@/lib/storage/box-oauth-state";
import { googleAccountName, googleExchangeCode } from "@/lib/storage/google-drive";
import { recordProviderAccount } from "@/lib/platform/accounts";
import { saveTokens } from "@/lib/storage/oauth-tokens";

/**
 * Google Drive sends the admin back here after they approve (or refuse) access. The signed `state` is checked, and its server and profile are
 * re-checked against the live session, exactly as for Box.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const fail = (serverId: string | null, why: string) => NextResponse.redirect(serverId ? `${origin}/s/${serverId}/admin?error=${why}` : `${origin}/servers?error=${why}`);

  const state = searchParams.get("state");
  const payload = state ? verifyBoxOAuthState(state) : null;
  if (!payload || !payload.connectionId) return fail(null, "storage-connect-failed");
  const member = await getCurrentServerAdmin(payload.serverId);
  if (!member || member.profile.id !== payload.profileId) return fail(null, "storage-connect-failed");
  if (searchParams.get("error")) return fail(payload.serverId, "storage-connect-cancelled");
  const code = searchParams.get("code");
  if (!code) return fail(payload.serverId, "storage-connect-failed");

  try {
    const [existing] = await db.select({ serverId: storageConnections.serverId, provider: storageConnections.provider }).from(storageConnections).where(eq(storageConnections.id, payload.connectionId)).limit(1);
    // An id that is some other server's, or another kind of storage, is never ours to write to.
    if (existing && (existing.serverId !== payload.serverId || existing.provider !== "gdrive")) throw new Error("not this server's Google Drive connection");

    const tokens = await googleExchangeCode(code, `${origin}/api/google/callback`);
    if (!tokens.refreshToken) throw new Error("Google Drive gave no refresh token");
    if (!existing) await db.insert(storageConnections).values({ id: payload.connectionId, serverId: payload.serverId, provider: "gdrive", label: payload.label || "Google Drive" });
    const account = await googleAccountName(tokens.accessToken);
    await saveTokens(payload.connectionId, tokens, account);
    await recordProviderAccount("gdrive", account);
  } catch {
    return fail(payload.serverId, "storage-connect-failed");
  }
  return NextResponse.redirect(`${origin}/s/${payload.serverId}/admin`);
}
