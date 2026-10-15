/** The check every /api/v1 route for a server makes: who is asking (a browser session or a device token), which profile, and whether they belong. */
import { resolveAccess, type Resolved } from "@/lib/tv/context";
import { apiError, apiNotFound, apiUnauthorized, asId } from "@/lib/api/v1";

export type ApiAccess = Extract<Resolved, { ok: true }>;

/** The access for a server id in the address, or the response to send: 401 signed out, 409 no profile chosen yet, 404 not a member (or a bad id). */
export async function apiAccess(rawServerId: string): Promise<{ ok: true; access: ApiAccess } | { ok: false; response: Response }> {
  const serverId = asId(rawServerId);
  if (!serverId) return { ok: false, response: apiNotFound() };
  const r = await resolveAccess(serverId);
  if (r.ok) return { ok: true, access: r };
  if (r.reason === "signed_out") return { ok: false, response: apiUnauthorized() };
  if (r.reason === "no_profile") return { ok: false, response: apiError(409, "Choose a profile first.", "profile_required") };
  return { ok: false, response: apiNotFound() };
}
