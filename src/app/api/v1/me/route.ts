import { getCurrentViewer } from "@/lib/auth/viewer";
import { apiJson, apiUnauthorized } from "@/lib/api/v1";
import { profileSummary } from "@/lib/api/v1-me";

/** Who this is: the account, the profile in use (null until one is chosen), and every profile to choose from. */
export async function GET() {
  const who = await getCurrentViewer();
  if (!who) return apiUnauthorized();
  return apiJson({
    account: { id: who.account.id, email: who.account.email, displayName: who.account.displayName, isGuest: who.account.isGuest },
    profile: who.viewer ? { ...profileSummary(who.viewer, who.viewer.id), locale: who.viewer.locale, maxAge: who.viewer.maxAge } : null,
    profiles: who.viewers.map((v) => profileSummary(v, who.viewer?.id ?? null)),
  });
}
