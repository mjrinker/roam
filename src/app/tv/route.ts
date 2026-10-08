import { getCurrentViewer } from "@/lib/auth/viewer";
import { listServerMemberships } from "@/lib/auth/servers";
import { html, redirectTo } from "@/lib/tv/http";
import { messagePage, serversPage } from "@/tv/render";

/** The TV's front door: sign in if needed, pick a profile if needed, then straight into the only server or a list of them. */
export async function GET(request: Request) {
  const resolved = await getCurrentViewer();
  if (!resolved) return redirectTo(request, "/tv/pair");
  if (!resolved.viewer) return redirectTo(request, "/tv/profiles");
  const memberships = await listServerMemberships(resolved.account.id);
  if (memberships.length === 0) return html(messagePage("No servers yet", "Join or create a server on roam from a phone or computer first."));
  if (memberships.length === 1) return redirectTo(request, `/tv/s/${memberships[0].serverId}`);
  return html(serversPage(memberships.map((m) => ({ id: m.serverId, name: m.serverName }))));
}
