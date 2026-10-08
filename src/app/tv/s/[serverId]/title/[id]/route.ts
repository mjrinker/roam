import { db } from "@/lib/db/client";
import { formatRemaining, formatRuntime } from "@/lib/format";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { movieDetail } from "@/lib/tv/data";
import { html } from "@/lib/tv/http";
import { detailPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/title/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;

  const movie = await movieDetail(db, access.scope, id);
  if (!movie) return notFoundPage();
  const t = movie.title;
  const watch = `${access.base}/watch/title/${id}`;
  const remaining = movie.resume?.durationSeconds ? formatRemaining(movie.resume.durationSeconds, movie.resume.positionSeconds) : null;
  return html(
    detailPage({
      title: t.name,
      meta: [t.year, formatRuntime(t.runtimeSeconds)].filter(Boolean).join(" · "),
      overview: t.overview,
      posterUrl: t.posterUrl,
      backHref: `${access.base}/library/${movie.libraryId}`,
      actions: [{ href: watch, label: movie.resume ? `Resume${remaining ? ` (${remaining})` : ""}` : "Play", primary: true }, { href: `${access.base}/library/${movie.libraryId}`, label: "Back to library" }],
    })
  );
}
