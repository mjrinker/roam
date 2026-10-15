import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { cleanLabel } from "@/lib/auth/device-token";
import { apiError, apiJson, readBody } from "@/lib/api/v1";
import { formatUserCode, locationHint, PAIRING_TTL_MS, startPairing } from "@/lib/tv/pairing";
import { canonicalOrigin } from "@/lib/tv/origin";
import { clientAddress } from "@/lib/tv/http";

const body = z.object({ label: z.string().max(80).optional() }).strict();

/**
 * An app or device asks to be signed in. It is given a short code to show (the person types it at /link on a phone or computer where
 * they are signed in) and a secret to poll with. Nothing here is sensitive until the code is approved.
 */
export async function POST(request: Request) {
  const data = await readBody(request, body.default({}));
  if (data instanceof NextResponse) return data;
  const started = await startPairing(db, { ip: clientAddress(request), userAgent: request.headers.get("user-agent"), label: cleanLabel(data.label, "") || null, location: locationHint(request.headers) });
  if (!started.ok) return apiError(429, started.reason === "too_many" ? "This device has asked for too many codes. Wait a little while." : "Roam is busy. Try again in a minute.", "rate_limited");
  const origin = canonicalOrigin(request.url);
  return apiJson({
    userCode: formatUserCode(started.userCode),
    deviceCode: started.secret,
    verificationUrl: `${origin}/link`,
    verificationUrlComplete: `${origin}/link?code=${started.userCode}`,
    expiresIn: Math.floor(PAIRING_TTL_MS / 1000),
    interval: 3,
  });
}
