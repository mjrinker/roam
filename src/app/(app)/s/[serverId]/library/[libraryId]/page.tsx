import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { libraries, titles } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { TitleCard, type TitleCardData } from "@/components/library/title-card";

export default async function LibraryDetailPage({
  params,
}: PageProps<"/s/[serverId]/library/[libraryId]">) {
  const { serverId, libraryId } = await params;
  await requireServerMember(serverId);

  // Confirm the library actually belongs to this server before showing
  // anything — don't trust the bare id from the URL.
  const [library] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.serverId, serverId)))
    .limit(1);
  if (!library) notFound();

  // A library's titles are homogeneous in kind (movies|shows) — the
  // scanner only ever writes one kind of title into a given library — so
  // no movies/shows split is needed here, unlike the old single-page view.
  const libraryTitles = await db
    .select()
    .from(titles)
    .where(eq(titles.libraryId, libraryId))
    .orderBy(desc(titles.addedAt));

  function toCard(t: (typeof libraryTitles)[number]): TitleCardData {
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      year: t.year,
      posterUrl: t.posterUrl,
      runtimeSeconds: t.runtimeSeconds,
    };
  }

  return (
    <div className="flex flex-col gap-4 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{library.name}</h1>
      {libraryTitles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing here yet. Head to Admin and rescan this library.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {libraryTitles.map((t) => (
            <TitleCard key={t.id} title={toCard(t)} serverId={serverId} />
          ))}
        </div>
      )}
    </div>
  );
}
