import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { continueWatching, tvLibraries } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { homePage } from "@/tv/render";

const KIND_LABEL: Record<string, string> = { movies: "Movies", shows: "TV Shows" };

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  const [libs, cont] = await Promise.all([tvLibraries(db, access.scope), continueWatching(db, access.scope)]);
  return html(
    homePage({
      serverName: server?.name ?? "Roam",
      base: access.base,
      profileName: access.profileName,
      continueWatching: cont.map((c) => ({ href: `${access.base}/watch/${c.kind}/${c.id}`, name: c.name, meta: c.meta, posterUrl: c.posterUrl, progress: c.progress })),
      libraries: libs.supported.map((l) => ({ id: l.id, name: l.name, kind: KIND_LABEL[l.kind] ?? l.kind })),
      unsupported: libs.unsupported,
    })
  );
}
