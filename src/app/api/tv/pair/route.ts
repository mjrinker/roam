import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { approvePairing, findOpenPairing, normalizeUserCode } from "@/lib/tv/pairing";

const body = z.object({ code: z.string().max(40), approve: z.boolean().optional() });
const invalid = () => NextResponse.json({ error: "That code isn't valid or has expired." }, { status: 404 });

/**
 * Approving a TV's sign-in code, in two steps from a phone or computer that is already signed in: look the code up (to be shown which
 * TV it belongs to), then approve it. A wrong, expired and already-used code all answer the same way, and the number of tries is limited
 * per account so a code can't be guessed. Guests (who have no email to sign a TV in with) can't approve.
 */
export async function POST(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (account.isGuest) return NextResponse.json({ error: "Guests can't sign in a TV. Create an account first." }, { status: 403 });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (!(await checkRateLimit(account.id, "tv_pair", 30, 10 * 60))) return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });

  const code = normalizeUserCode(parsed.data.code);
  if (!code) return invalid();
  const open = await findOpenPairing(db, code);
  if (!open) return invalid();
  if (!parsed.data.approve) return NextResponse.json({ deviceLabel: open.deviceLabel, location: open.locationHint, startedAt: open.createdAt.toISOString() });

  return (await approvePairing(db, { userCode: code, accountId: account.id })) ? NextResponse.json({ ok: true, deviceLabel: open.deviceLabel }) : invalid();
}
