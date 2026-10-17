import { db } from "@/lib/db/client";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { html } from "@/lib/tv/http";
import { bookDetail } from "@/lib/tv/data";
import { formatClock } from "@/tv/client/clock";
import { doneWords } from "@/lib/watch/words";
import { labelSection, ownershipSections } from "@/lib/tv/sections";
import { onWatchlist } from "@/lib/watchlist/queries";
import { labelsForTitle } from "@/lib/labels/service";
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
  const listed = (await onWatchlist(db, access.scope.viewerId, [id])).has(id);
  const by = (t.authors ?? []).join(", ") || t.folderAuthor;
  const narrator = (t.narrators ?? []).join(", ");
  const meta = [by, narrator ? `Read by ${narrator}` : null, t.seriesName ? `${t.seriesName}${t.seriesPosition ? ` #${t.seriesPosition}` : ""}` : null].filter(Boolean).join(" · ");
  const labelBox = labelSection({ base: access.base, titleId: id, back: `${access.base}/book/${id}`, labels: await labelsForTitle(db, access.scope.viewerId, id) });
  const sections = [...(labelBox ? [labelBox] : []), ...(await ownershipSections(db, { serverId, base: access.base, who: access.who, viewerId: access.scope.viewerId, libraryKind: "audiobooks", titleId: id, back: `${access.base}/book/${id}` }))];
  return html(
    detailPage({
      sections,
      title: t.name,
      meta,
      overview: t.overview,
      posterUrl: t.posterUrl,
      square: true,
      backHref: `${access.base}/library/${book.libraryId}`,
      posts: [{ action: `${access.base}/watchlist`, label: listed ? "Take off watch list" : "Add to watch list", fields: { id: id, on: listed ? "0" : "1", back: `${access.base}/book/${id}` } }, { action: `${access.base}/mark`, label: book.finished ? doneWords("listen").markUndone : doneWords("listen").markDone, fields: { kind: "title", id, done: book.finished ? "0" : "1", back: `${access.base}/book/${id}` } }],
      actions: [{ href: `${access.base}/listen/${id}`, label: book.resume ? `Resume from ${formatClock(book.resume.positionSeconds)}` : "Listen", primary: true }, { href: `${access.base}/add?title=${id}&back=${encodeURIComponent(`${access.base}/book/${id}`)}`, label: "Add to playlist" }],
    })
  );
}
