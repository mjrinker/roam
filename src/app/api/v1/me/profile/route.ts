import { z } from "zod";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getCurrentProfile, getRequestDeviceToken } from "@/lib/auth/guards";
import { setTokenProfile } from "@/lib/auth/device-token";
import { viewers } from "@/lib/db/schema";
import { apiError, apiJson, apiNotFound, apiUnauthorized, readBody } from "@/lib/api/v1";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyPin } from "@/lib/viewers/pin";

const body = z.object({ viewerId: z.string().uuid(), pin: z.string().max(12).optional() }).strict();

/** The device chooses which profile it is using. A profile with a PIN needs it, with the same limits on guessing as the web. */
export async function POST(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return apiUnauthorized();
  const device = await getRequestDeviceToken();
  if (!device) return apiError(400, "This is for apps signed in with a device token; on the web, choose a profile from the profile screen.", "device_token_required");
  const data = await readBody(request, body);
  if (data instanceof NextResponse) return data;
  // Looking the profile up among this account's own is the ownership check.
  const [viewer] = await db.select().from(viewers).where(and(eq(viewers.id, data.viewerId), eq(viewers.accountId, account.id))).limit(1);
  if (!viewer) return apiNotFound();
  if (viewer.pinHash) {
    if (!((await checkRateLimit(account.id, `pin:${viewer.id}`, 5, 15 * 60)) && (await checkRateLimit(account.id, "pin", 20, 60 * 60)))) return apiError(429, "Too many attempts. Try again in a few minutes.", "rate_limited");
    if (!data.pin || !verifyPin(data.pin, viewer.pinHash)) return apiError(401, "Incorrect PIN", "incorrect_pin");
  }
  await setTokenProfile(db, device.id, viewer);
  return apiJson({ ok: true, profileId: viewer.id });
}
