import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getCurrentProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { signViewerCookie, VIEWER_COOKIE, VIEWER_COOKIE_MAX_AGE_SECONDS } from "@/lib/viewers/cookie";
import { verifyPin } from "@/lib/viewers/pin";

const bodySchema = z.object({ pin: z.string().optional() });

/** Choose who's watching on this device. A PIN-protected profile needs its PIN. */
export async function POST(request: Request, ctx: RouteContext<"/api/viewers/[id]/select">) {
  const { id } = await ctx.params;
  const account = await getCurrentProfile();
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  // Scoping by account is the ownership check: another account's profile 404s.
  const [viewer] = await db
    .select()
    .from(viewers)
    .where(and(eq(viewers.id, id), eq(viewers.accountId, account.id)))
    .limit(1);
  if (!viewer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (viewer.pinHash) {
    // Keyed by account: the person guessing is someone already signed in to it.
    const withinLimits =
      (await checkRateLimit(account.id, `pin:${viewer.id}`, 5, 15 * 60)) &&
      (await checkRateLimit(account.id, "pin", 20, 60 * 60));
    if (!withinLimits) {
      return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
    }
    if (!parsed.data.pin || !verifyPin(parsed.data.pin, viewer.pinHash)) {
      return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });
    }
  }

  (await cookies()).set(
    VIEWER_COOKIE,
    signViewerCookie({ viewerId: viewer.id, accountId: account.id, pinVersion: viewer.pinVersion }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: VIEWER_COOKIE_MAX_AGE_SECONDS,
    }
  );
  return NextResponse.json({ ok: true });
}
