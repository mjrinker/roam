import { cookies } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";
import { getCurrentProfile } from "@/lib/auth/guards";
import { listViewers } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { html, redirectTo } from "@/lib/tv/http";
import { signViewerCookie, VIEWER_COOKIE, VIEWER_COOKIE_MAX_AGE_SECONDS } from "@/lib/viewers/cookie";
import { messagePage, profilesPage } from "@/tv/render";

/**
 * Who's watching, for a TV. A profile protected by a PIN is not offered (there is no way to type a PIN with a remote yet), so a TV
 * can only ever act as a profile that anyone signed in to the account could already pick. `?viewer=` chooses one.
 */
export async function GET(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return redirectTo(request, "/tv/pair");
  const open = (await listViewers(account.id)).filter((v) => !v.pinHash);
  if (open.length === 0) return html(messagePage("No profiles available", "Every profile on this account has a PIN. Profiles with a PIN can't be used on a TV yet.", { href: "/tv/signout", label: "Sign out" }));

  const wanted = new URL(request.url).searchParams.get("viewer") ?? (open.length === 1 ? open[0].id : null);
  if (!wanted) return html(profilesPage({ profiles: open.map((v) => ({ id: v.id, name: v.name })), selectUrl: "/tv/profiles" }));

  // Scoping by account and by "no PIN" is the ownership check: someone else's profile, or a protected one, is simply not found.
  const [viewer] = await db.select().from(viewers).where(and(eq(viewers.id, wanted), eq(viewers.accountId, account.id), isNull(viewers.pinHash))).limit(1);
  if (!viewer) return redirectTo(request, "/tv/profiles");
  (await cookies()).set(VIEWER_COOKIE, signViewerCookie({ viewerId: viewer.id, accountId: account.id, pinVersion: viewer.pinVersion }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: VIEWER_COOKIE_MAX_AGE_SECONDS,
  });
  return redirectTo(request, "/tv");
}
