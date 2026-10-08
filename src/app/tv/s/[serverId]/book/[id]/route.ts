import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { bookDetail } from "@/lib/tv/data";
import { formatClock } from "@/tv/client/clock";
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
      actions: [{ href: `${access.base}/listen/${id}`, label: book.resume ? `Resume from ${formatClock(book.resume.positionSeconds)}` : "Listen", primary: true }],
    })
  );
}
