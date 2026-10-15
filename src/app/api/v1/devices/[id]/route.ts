import { db } from "@/lib/db/client";
import { getCurrentProfile } from "@/lib/auth/guards";
import { revokeDeviceToken } from "@/lib/auth/device-token";
import { apiJson, apiNotFound, apiUnauthorized, asId } from "@/lib/api/v1";

/** Signs one of this account's devices out. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/v1/devices/[id]">) {
  const account = await getCurrentProfile();
  if (!account) return apiUnauthorized();
  const id = asId((await ctx.params).id);
  if (!id || !(await revokeDeviceToken(db, account.id, id))) return apiNotFound();
  return apiJson({ ok: true });
}
