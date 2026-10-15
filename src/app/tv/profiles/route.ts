import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getCurrentProfile } from "@/lib/auth/guards";
import { listViewers } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { html, redirectTo } from "@/lib/tv/http";
import { signViewerCookie, VIEWER_COOKIE, VIEWER_COOKIE_MAX_AGE_SECONDS } from "@/lib/viewers/cookie";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyPin } from "@/lib/viewers/pin";
import { pinPage, profilesPage } from "@/tv/render";

/**
 * Who's watching, for a TV. Choosing a profile is a POST, so a link on another site can't switch someone's profile. A profile with
 * a PIN gets a PIN pad (digits the remote can reach, kept out of the address) and the same attempt limits as the web; with only one
 * profile and no PIN, it is chosen for them.
 */
export async function GET(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return redirectTo(request, "/tv/pair");
  const all = await listViewers(account.id);
  if (all.length === 1 && !all[0].pinHash) return select(request, account.id, all[0].id);
  return html(profilesPage({ profiles: all.map((v) => ({ id: v.id, name: v.name, locked: !!v.pinHash })), selectUrl: "/tv/profiles" }));
}

export async function POST(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return redirectTo(request, "/tv/pair");
  const form = await request.formData().catch(() => null);
  const wanted = String(form?.get("viewer") ?? "");
  const pin = typeof form?.get("pin") === "string" ? (form!.get("pin") as string) : null;
  return select(request, account.id, wanted, pin);
}

async function select(request: Request, accountId: string, wanted: string, pin: string | null = null) {
  const account = { id: accountId };
  // Scoping by account is the ownership check: someone else's profile is simply not found.
  if (!/^[0-9a-f-]{36}$/i.test(wanted)) return redirectTo(request, "/tv/profiles");
  const [viewer] = await db.select().from(viewers).where(and(eq(viewers.id, wanted), eq(viewers.accountId, account.id))).limit(1);
  if (!viewer) return redirectTo(request, "/tv/profiles");
  if (viewer.pinHash) {
    // No PIN yet: ask for it. A wrong one asks again; guessing is limited the same way as on the web (keyed by account).
    if (pin === null || pin === "") return html(pinPage({ profileName: viewer.name, viewerId: viewer.id, selectUrl: "/tv/profiles" }));
    const withinLimits = (await checkRateLimit(account.id, `pin:${viewer.id}`, 5, 15 * 60)) && (await checkRateLimit(account.id, "pin", 20, 60 * 60));
    if (!withinLimits) return html(pinPage({ profileName: viewer.name, viewerId: viewer.id, selectUrl: "/tv/profiles", error: "Too many tries. Wait a few minutes." }), 429);
    if (!/^\d{4}$/.test(pin) || !verifyPin(pin, viewer.pinHash)) return html(pinPage({ profileName: viewer.name, viewerId: viewer.id, selectUrl: "/tv/profiles", error: "That PIN isn't right." }), 401);
  }
  (await cookies()).set(VIEWER_COOKIE, signViewerCookie({ viewerId: viewer.id, accountId: account.id, pinVersion: viewer.pinVersion }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: VIEWER_COOKIE_MAX_AGE_SECONDS,
  });
  return redirectTo(request, "/tv");
}
