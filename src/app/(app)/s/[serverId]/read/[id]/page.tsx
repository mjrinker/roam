import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requireServerMember } from "@/lib/auth/guards";
import { isAllowed } from "@/lib/content/access";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { isUuid } from "@/lib/playlists/http";
import { EpubReader } from "@/components/ebooks/epub-reader";

export default async function ReadPage({ params }: PageProps<"/s/[serverId]/read/[id]">) {
  const { serverId, id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, viewer, role } = await requireServerMember(serverId);

  const [row] = await db
    .select({ title: titles })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(titles.kind, "ebook"), libraryVisible(db, libraryActor({ profile, role }, serverId))))
    .limit(1);
  const book = row?.title;
  if (!book || !isAllowed(viewer, book.ratingAges)) notFound();

  const [file] = await db
    .select({ container: mediaFiles.container, sizeBytes: mediaFiles.sizeBytes })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id), eq(mediaFiles.partIndex, 0)))
    .limit(1);
  // Only EPUBs are read in the page; a PDF opens from its book page.
  if (file?.container !== "epub") redirect(`/s/${serverId}/ebook/${id}`);

  return (
    <EpubReader
      titleId={id}
      viewerId={viewer.id}
      title={book.name}
      backHref={`/s/${serverId}/ebook/${id}`}
      downloadHref={`/api/ebooks/${id}/file`}
      sizeBytes={file.sizeBytes}
    />
  );
}
