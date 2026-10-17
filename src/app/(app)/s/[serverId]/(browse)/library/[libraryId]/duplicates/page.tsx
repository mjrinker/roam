import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ScanSearch } from "lucide-react";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { requireServerAdmin } from "@/lib/auth/guards";
import { isUuid } from "@/lib/playlists/http";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { DuplicateFinder } from "@/components/photos/duplicate-finder";

/** Duplicate photos in a photo library: for the server's admin. */
export default async function DuplicatesPage({ params }: PageProps<"/s/[serverId]/library/[libraryId]/duplicates">) {
  const { serverId, libraryId } = await params;
  if (!isUuid(libraryId)) notFound();
  await requireServerAdmin(serverId);
  const [library] = await db.select({ name: libraries.name, kind: libraries.kind }).from(libraries).where(and(eq(libraries.id, libraryId), eq(libraries.serverId, serverId)));
  if (!library || !isPhotoLibraryKind(library.kind)) notFound();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: library.name, href: `/s/${serverId}/library/${libraryId}` }, { label: "Duplicates" }]} />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <ScanSearch className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Duplicate photos</h1>
          <p className="text-sm text-muted-foreground">Find the same picture saved more than once, and hide the extra copies from {library.name}.</p>
        </div>
      </div>
      <DuplicateFinder libraryId={libraryId} />
    </div>
  );
}
