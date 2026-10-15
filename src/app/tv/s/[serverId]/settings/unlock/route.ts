import { cookies } from "next/headers";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { checkRateLimit } from "@/lib/rate-limit";
import { canChangeOwnSettings, signUnlock, UNLOCK_COOKIE } from "@/lib/tv/settings";
import { getViewerRow } from "@/lib/tv/viewer-row";
import { verifyPin } from "@/lib/viewers/pin";
import { pinPage } from "@/tv/render";

/** The PIN for changing settings: right, and the settings page opens for a few minutes; wrong, it asks again (guessing is limited as on the web). */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/settings/unlock">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const w = access.who;
  if (!canChangeOwnSettings({ id: w.viewerId, role: w.viewerRole })) return notFoundPage();
  const row = await getViewerRow(w.viewerId);
  if (!row || !row.pinHash) return redirectTo(request, `${access.base}/settings`, 303);
  const page = (error: string, status: number) => html(pinPage({ profileName: row.name, viewerId: row.id, selectUrl: `${access.base}/settings/unlock`, backHref: access.base, heading: "Enter your PIN to change settings", error }), status);
  const form = await request.formData().catch(() => null);
  const pin = typeof form?.get("pin") === "string" ? (form!.get("pin") as string) : "";
  const withinLimits = (await checkRateLimit(w.accountId, `pin:${row.id}`, 5, 15 * 60)) && (await checkRateLimit(w.accountId, "pin", 20, 60 * 60));
  if (!withinLimits) return page("Too many tries. Wait a few minutes.", 429);
  if (!/^\d{4}$/.test(pin) || !verifyPin(pin, row.pinHash)) return page("That PIN isn't right.", 401);
  (await cookies()).set(UNLOCK_COOKIE, signUnlock(row.id, row.pinVersion), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/tv", maxAge: 600 });
  return redirectTo(request, `${access.base}/settings`, 303);
}
