import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { continueWatching, recentlyAdded, tvLibraries, upNext } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { tvPlaylists } from "@/lib/tv/playlists";
import { isPhotoLibraryKind, TV_KIND_LABEL } from "@/lib/libraries/profile";
import { unreadCount } from "@/lib/ownership/notify";
import { canChangeOwnSettings } from "@/lib/tv/settings";
import { recommendations } from "@/lib/recommend/service";
import { listWatchlist } from "@/lib/watchlist/queries";
import { listLabels } from "@/lib/labels/service";
import { homePage } from "@/tv/render";


export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  const [libs, cont, next, recent, lists, recs, listed] = await Promise.all([tvLibraries(db, access.scope), continueWatching(db, access.scope), upNext(db, access.scope), recentlyAdded(db, access.scope), tvPlaylists(db, access.scope), recommendations(db, { actor: access.scope.actor, viewer: access.scope.viewer, viewerId: access.scope.viewerId }), listWatchlist(db, { actor: access.scope.actor, viewer: access.scope.viewer, viewerId: access.scope.viewerId, serverId, limit: 20 })]);
  return html(
    homePage({
      serverName: server?.name ?? "Roam",
      base: access.base,
      profileName: access.profileName,
      continueWatching: cont.watching.map((c) => ({ href: `${access.base}/watch/${c.kind}/${c.id}`, name: c.name, meta: c.meta, posterUrl: c.posterUrl, progress: c.progress })),
      upNext: next.map((c) => ({ href: `${access.base}/watch/episode/${c.id}`, name: c.name, meta: c.meta, posterUrl: c.posterUrl })),
      watchlist: listed.map((r) => ({ href: `${access.base}/${r.kind === "show" ? "show" : r.kind === "audiobook" ? "book" : "title"}/${r.id}`, name: r.name, meta: r.year ? String(r.year) : null, posterUrl: r.posterUrl, square: r.kind === "audiobook" })),
      recommended: recs.forYou.map((r) => ({ href: `${access.base}/${r.kind === "show" ? "show" : "title"}/${r.id}`, name: r.name, meta: r.year ? String(r.year) : null, posterUrl: r.posterUrl })),
      continueListening: cont.listening.map((c) => ({ href: `${access.base}/listen/${c.id}`, name: c.name, meta: c.meta, posterUrl: c.posterUrl, progress: c.progress, square: true })),
      hasPlaylists: lists.length > 0,
      hasLabels: (await listLabels(db, access.scope.viewerId)).length > 0,
      unread: await unreadCount(db, access.who.accountId),
      hasSettings: canChangeOwnSettings({ id: access.who.viewerId, role: access.who.viewerRole }),
      screensaver: libs.supported.some((l) => isPhotoLibraryKind(l.kind)) ? { href: `${access.base}/screensaver`, afterSeconds: 300 } : null,
      recentlyAdded: recent.map((r) => ({ href: `${access.base}${r.href}`, name: r.name, meta: r.meta, posterUrl: r.posterUrl, square: r.square })),
      libraries: libs.supported.map((l) => ({ id: l.id, name: l.name, kind: TV_KIND_LABEL[l.kind] ?? l.kind })),
      unsupported: libs.unsupported,
    })
  );
}
