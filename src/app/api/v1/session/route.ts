import { db } from "@/lib/db/client";
import { getRequestDeviceToken } from "@/lib/auth/guards";
import { revokeDeviceToken } from "@/lib/auth/device-token";
import { apiError, apiJson, apiUnauthorized } from "@/lib/api/v1";

/** Signs this device out: its token stops working at once. */
export async function DELETE() {
  const device = await getRequestDeviceToken();
  if (device === undefined) return apiError(400, "Not signed in with a device token.", "device_token_required");
  if (!device) return apiUnauthorized();
  await revokeDeviceToken(db, device.accountId, device.id);
  return apiJson({ ok: true });
}
