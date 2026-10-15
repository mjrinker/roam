import { getCurrentProfile } from "@/lib/auth/guards";
import { listServerMemberships } from "@/lib/auth/servers";
import { apiJson, apiUnauthorized } from "@/lib/api/v1";

/** The servers this account belongs to. */
export async function GET() {
  const account = await getCurrentProfile();
  if (!account) return apiUnauthorized();
  const list = await listServerMemberships(account.id);
  return apiJson({ servers: list.map((s) => ({ id: s.serverId, name: s.serverName, role: s.role })) });
}
