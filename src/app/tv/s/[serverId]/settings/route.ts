import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { sameHost } from "@/lib/tv/form";
import { html, redirectTo } from "@/lib/tv/http";
import { AUTO_SKIP_KINDS, CATEGORY_ROWS, canChangeOwnSettings, cycleCategory, severityWords, toggleAutoSkip, UNLOCK_COOKIE, unlockValid } from "@/lib/tv/settings";
import { getViewerRow } from "@/lib/tv/viewer-row";
import { messagePage, pinPage, settingsPage } from "@/tv/render";

/** This profile's own settings. A child's profile is told to ask a grown-up; a profile with a PIN is asked for it first (as the web does). */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/settings">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const w = access.who;
  if (!canChangeOwnSettings({ id: w.viewerId, role: w.viewerRole })) {
    return html(messagePage("Ask a grown-up", "These settings can be changed from a grown-up's profile.", { href: access.base, label: "Back" }), 403);
  }
  const row = await getViewerRow(w.viewerId);
  if (!row) return notFoundPage();
  if (row.pinHash && !unlockValid((await cookies()).get(UNLOCK_COOKIE)?.value, row.id, row.pinVersion)) {
    return html(pinPage({ profileName: row.name, viewerId: row.id, selectUrl: `${access.base}/settings/unlock`, backHref: access.base, heading: "Enter your PIN to change settings" }));
  }
  const focus = new URL(request.url).searchParams.get("f");
  return html(
    settingsPage({
      base: access.base,
      profileName: row.name,
      groupCollections: w.groupCollections,
      autoSkip: AUTO_SKIP_KINDS.map((k) => ({ key: k.key, label: k.label, on: w.autoSkip[k.key] === true })),
      filters: CATEGORY_ROWS.map((c) => ({ key: c.key, label: c.label, words: severityWords(w.filterPrefs[c.key]) })),
      focus: focus && /^(auto|filter|group):[a-z]+$/.test(focus) ? focus : null,
    })
  );
}

/** Changes one setting to its next choice, then returns to the page with the same button selected. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/settings">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const w = access.who;
  if (!canChangeOwnSettings({ id: w.viewerId, role: w.viewerRole })) return html(messagePage("Ask a grown-up", "These settings can be changed from a grown-up's profile.", { href: access.base, label: "Back" }), 403);
  const row = await getViewerRow(w.viewerId);
  if (!row) return notFoundPage();
  if (row.pinHash && !unlockValid((await cookies()).get(UNLOCK_COOKIE)?.value, row.id, row.pinVersion)) return redirectTo(request, `${access.base}/settings`, 303);
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage();
  const kind = form.get("kind");
  const key = form.get("key");
  if (kind === "auto") {
    const next = toggleAutoSkip(w.autoSkip, key);
    if (!next) return notFoundPage();
    await db.update(viewers).set({ autoSkip: next }).where(eq(viewers.id, row.id));
  } else if (kind === "group") {
    await db.update(viewers).set({ groupCollections: !w.groupCollections }).where(eq(viewers.id, row.id));
  } else if (kind === "filter") {
    const next = cycleCategory(w.filterPrefs, key);
    if (!next) return notFoundPage();
    await db.update(viewers).set({ contentFilter: next }).where(eq(viewers.id, row.id));
  } else return notFoundPage();
  return redirectTo(request, `${access.base}/settings?f=${kind}:${key}`, 303); // 303: the browser must GET the page, never re-send the form
}
