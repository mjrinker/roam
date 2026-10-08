import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { BookOpen, Download } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import { requireServerMember } from "@/lib/auth/guards";
import { isAllowed } from "@/lib/content/access";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { formatFileSize } from "@/lib/format";
import { isUuid } from "@/lib/playlists/http";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";

export default async function EbookPage({ params }: PageProps<"/s/[serverId]/ebook/[id]">) {
  const { serverId, id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, viewer, role } = await requireServerMember(serverId);

  // Joined through libraries so a book id from a DIFFERENT server (or a hidden library) is just not found.
  const [row] = await db
    .select({ title: titles, libraryId: libraries.id, libraryName: libraries.name })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(titles.kind, "ebook"), libraryVisible(db, libraryActor({ profile, role }, serverId))))
    .limit(1);
  const book = row?.title;
  if (!book || !isAllowed(viewer, book.ratingAges)) notFound();

  const [file] = await db
    .select({ filename: mediaFiles.filename, sizeBytes: mediaFiles.sizeBytes, container: mediaFiles.container })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id), eq(mediaFiles.partIndex, 0)))
    .limit(1);

  const authors = book.authors?.length ? book.authors : book.folderPath ? [book.folderPath.split("/")[0]] : [];
  const series = book.seriesName ? (book.seriesPosition ? `${book.seriesName} · Book ${book.seriesPosition}` : book.seriesName) : null;
  const details = [book.year, file?.container?.toUpperCase(), formatFileSize(file?.sizeBytes)].filter(Boolean).join(" · ");
  const href = `/api/ebooks/${id}/file`;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: row.libraryName, href: `/s/${serverId}/library/${row.libraryId}` }, { label: book.name }]} />
      <div className="flex flex-col items-center gap-8 md:flex-row md:items-start">
        <div className="relative aspect-[2/3] w-52 shrink-0 overflow-hidden rounded-xl bg-muted shadow-[0_30px_70px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10 md:w-64">
          {book.posterUrl ? (
            <Image src={book.posterUrl} alt={`${book.name} cover`} fill sizes="256px" className="object-cover" priority />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary via-muted to-background p-6 text-center">
              <BookOpen className="size-10 text-muted-foreground/60" />
              <span className="line-clamp-4 text-sm font-medium text-muted-foreground">{book.name}</span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 text-center md:text-left">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{book.name}</h1>
            {authors.length > 0 && <p className="mt-2 text-lg text-muted-foreground">{authors.join(", ")}</p>}
            {series && <p className="mt-1 text-sm text-muted-foreground">{series}</p>}
            {details && <p className="mt-1 text-sm text-muted-foreground">{details}</p>}
          </div>
          <div className="flex justify-center md:justify-start">
            <a
              href={href}
              className="inline-flex h-12 items-center gap-2.5 rounded-xl bg-primary px-8 text-base font-semibold text-primary-foreground shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)] transition hover:opacity-90"
            >
              <Download className="size-5" /> {file?.container === "pdf" ? "Open PDF" : "Download"}
            </a>
          </div>
          {book.overview && <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{book.overview}</p>}
        </div>
      </div>
    </div>
  );
}
