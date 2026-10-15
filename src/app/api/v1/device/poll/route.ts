import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { listViewers } from "@/lib/auth/viewer";
import { createDeviceToken } from "@/lib/auth/device-token";
import { apiJson, readBody } from "@/lib/api/v1";
import { profileSummary } from "@/lib/api/v1-me";
import { pollPairing, releasePairing } from "@/lib/tv/pairing";
import { profiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const body = z.object({ deviceCode: z.string().min(20).max(100) }).strict();

/**
 * The device asks whether its code has been approved. `pending` (keep asking every few seconds), `expired` (start again), or
 * `approved` with the device's token, handed over exactly once: keep it, it is not shown again.
 */
export async function POST(request: Request) {
  const data = await readBody(request, body);
  if (data instanceof NextResponse) return data;
  const result = await pollPairing(db, data.deviceCode);
  if (result.status !== "approved") return apiJson({ status: result.status });
  try {
    const { token, row } = await createDeviceToken(db, { accountId: result.accountId, label: result.deviceLabel });
    const [account] = await db.select().from(profiles).where(eq(profiles.id, result.accountId)).limit(1);
    const all = await listViewers(result.accountId);
    return apiJson({
      status: "approved",
      accessToken: token,
      tokenType: "Bearer",
      account: { id: account.id, email: account.email, displayName: account.displayName },
      profiles: all.map((v) => profileSummary(v, row.viewerId)),
      profileSelected: !!row.viewerId,
    });
  } catch (e) {
    console.error("Device sign-in could not be completed:", e);
    await releasePairing(db, data.deviceCode); // the next poll tries again, until the code lapses
    return apiJson({ status: "pending" });
  }
}
