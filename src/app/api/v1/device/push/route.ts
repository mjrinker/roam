import { db } from "@/lib/db/client";
import { getRequestDeviceToken } from "@/lib/auth/guards";
import { setPushToken } from "@/lib/push/fcm";
import { apiError, apiJson, apiUnauthorized } from "@/lib/api/v1";

/** An app tells Roam where to send its notifications (its Firebase registration token); only an app signed in with a device token can. */
export async function PUT(request: Request) {
  const device = await getRequestDeviceToken();
  if (!device) return apiUnauthorized();
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) return apiError(400, "That isn't a push token.", "invalid_request");
  await setPushToken(db, device.id, token);
  return apiJson({ ok: true });
}

/** The app no longer wants notifications. */
export async function DELETE() {
  const device = await getRequestDeviceToken();
  if (!device) return apiUnauthorized();
  await setPushToken(db, device.id, null);
  return apiJson({ ok: true });
}
