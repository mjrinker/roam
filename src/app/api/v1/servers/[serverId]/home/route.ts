import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { continueWatching, recentlyAdded, tvLibraries, upNext } from "@/lib/tv/data";
import { tvPlaylists } from "@/lib/tv/playlists";
import { unreadCount } from "@/lib/ownership/notify";
import { tvBrowseStyle } from "@/lib/libraries/profile";
import { apiJson } from "@/lib/api/v1";
import { apiAccess } from "@/lib/api/access";
import { refFromHref, type ApiItem } from "@/lib/api/v1-shapes";

/** The home screen: what to continue, what's new, the libraries, and whether there is anything to look at in notifications. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/servers/[serverId]/home">) {
  const a = await apiAccess((await ctx.params).serverId);
  if (!a.ok) return a.response;
  const { scope, serverId, who } = a.access;
  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  const [libs, cont, next, recent, lists, unread] = await Promise.all([tvLibraries(db, scope), continueWatching(db, scope), upNext(db, scope), recentlyAdded(db, scope), tvPlaylists(db, scope), unreadCount(db, who.accountId)]);
  const watching: ApiItem[] = cont.watching.map((c) => ({ type: c.kind === "episode" ? "episode" : "movie", id: c.id, name: c.name, subtitle: c.meta, posterUrl: c.posterUrl, square: false, progress: c.progress }));
  const deck: ApiItem[] = next.map((c) => ({ type: "episode", id: c.id, name: c.name, subtitle: c.meta, posterUrl: c.posterUrl, square: false }));
  const listening: ApiItem[] = cont.listening.map((c) => ({ type: "audiobook", id: c.id, name: c.name, subtitle: c.meta, posterUrl: c.posterUrl, square: true, progress: c.progress }));
  const added: ApiItem[] = recent.flatMap((r) => {
    const ref = refFromHref(r.href);
    return ref ? [{ ...ref, name: r.name, subtitle: r.meta, posterUrl: r.posterUrl, square: r.square }] : [];
  });
  return apiJson({
    server: { id: serverId, name: server?.name ?? "Roam" },
    libraries: libs.supported.map((l) => ({ id: l.id, name: l.name, kind: l.kind, style: tvBrowseStyle(l.kind) })),
    unsupportedLibraries: libs.unsupported,
    continueWatching: watching,
    upNext: deck,
    continueListening: listening,
    recentlyAdded: added,
    hasPlaylists: lists.length > 0,
    unreadNotifications: unread,
  });
}
