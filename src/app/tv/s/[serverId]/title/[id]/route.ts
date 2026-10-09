import { db } from "@/lib/db/client";
import { libraryHasDoneState, tvBrowseStyle } from "@/lib/libraries/profile";
import { doneWords } from "@/lib/watch/words";
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
  // From a video library's folder, Back returns to that folder, not the top of the library.
  const library = `${access.base}/library/${movie.libraryId}${tvBrowseStyle(movie.libraryKind) === "folders" && t.folderPath ? `?path=${encodeURIComponent(t.folderPath)}` : ""}`;
  const remaining = movie.resume?.durationSeconds ? formatRemaining(movie.resume.durationSeconds, movie.resume.positionSeconds) : null;
  return html(
    detailPage({
      title: t.name,
      meta: [t.year, formatRuntime(t.runtimeSeconds)].filter(Boolean).join(" · "),
      overview: t.overview,
      posterUrl: t.posterUrl,
      backdropUrl: t.backdropUrl,
      backHref: library,
      posts: libraryHasDoneState(movie.libraryKind)
        ? [{ action: `${access.base}/mark`, label: movie.finished ? doneWords("watch").markUndone : doneWords("watch").markDone, fields: { kind: "title", id, done: movie.finished ? "0" : "1", back: `${access.base}/title/${id}` } }]
        : [],
      actions: [{ href: watch, label: movie.resume ? `Resume${remaining ? ` (${remaining})` : ""}` : "Play", primary: true }, { href: `${access.base}/add?title=${id}&back=${encodeURIComponent(`${access.base}/title/${id}`)}`, label: "Add to playlist" }],
    })
  );
}
