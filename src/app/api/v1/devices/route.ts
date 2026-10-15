import { db } from "@/lib/db/client";
import { getCurrentProfile, getRequestDeviceToken } from "@/lib/auth/guards";
import { listDeviceTokens } from "@/lib/auth/device-token";
import { apiJson, apiUnauthorized } from "@/lib/api/v1";

/** The devices signed in to this account (never their tokens), with when each was last used. */
export async function GET() {
  const account = await getCurrentProfile();
  if (!account) return apiUnauthorized();
  const current = await getRequestDeviceToken();
  const rows = await listDeviceTokens(db, account.id);
  return apiJson({ devices: rows.map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, current: !!current && current.id === d.id })) });
}
