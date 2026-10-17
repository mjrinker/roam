import { db } from "@/lib/db/client";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { visibleLabels } from "@/lib/labels/queries";

/** The profile's own labels with how many titles on this server (that it can see) each has. Change them with `/api/labels`. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/labels">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  const { scope, serverId } = a.access;
  return apiJson({ labels: await visibleLabels(db, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, serverId }) });
}
