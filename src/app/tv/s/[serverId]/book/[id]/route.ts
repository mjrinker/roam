import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { bookDetail } from "@/lib/tv/data";
import { formatClock } from "@/tv/client/clock";
import { doneWords } from "@/lib/watch/words";
import { detailPage } from "@/tv/render";

export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/book/[id]">) {
  const params = await ctx.params;
  const serverId = asUuid(params.serverId);
  const id = asUuid(params.id);
  if (!serverId || !id) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const book = await bookDetail(db, access.scope, id);
  if (!book) return notFoundPage();
  const t = book.title;
  const by = (t.authors ?? []).join(", ") || t.folderAuthor;
  const narrator = (t.narrators ?? []).join(", ");
  const meta = [by, narrator ? `Read by ${narrator}` : null, t.seriesName ? `${t.seriesName}${t.seriesPosition ? ` #${t.seriesPosition}` : ""}` : null].filter(Boolean).join(" · ");
  return html(
    detailPage({
      title: t.name,
      meta,
      overview: t.overview,
      posterUrl: t.posterUrl,
      square: true,
      backHref: `${access.base}/library/${book.libraryId}`,
      posts: [{ action: `${access.base}/mark`, label: book.finished ? doneWords("listen").markUndone : doneWords("listen").markDone, fields: { kind: "title", id, done: book.finished ? "0" : "1", back: `${access.base}/book/${id}` } }],
      actions: [{ href: `${access.base}/listen/${id}`, label: book.resume ? `Resume from ${formatClock(book.resume.positionSeconds)}` : "Listen", primary: true }, { href: `${access.base}/add?title=${id}&back=${encodeURIComponent(`${access.base}/book/${id}`)}`, label: "Add to playlist" }],
    })
  );
}
