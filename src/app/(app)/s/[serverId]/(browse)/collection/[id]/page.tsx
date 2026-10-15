import { notFound } from "next/navigation";
import { Layers } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { getCollection } from "@/lib/collections/queries";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PosterCard } from "@/components/library/poster-card";
import { CollectionAdminBar, RemoveFromCollectionButton } from "@/components/collections/collection-admin";

/** One collection: a film series or a hand-made group, with the titles of it this profile may see. */
export default async function CollectionPage({ params }: PageProps<"/s/[serverId]/collection/[id]">) {
  const { serverId, id } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);
  const c = await getCollection(db, { actor: lib, viewer, collectionId: id });
  if (!c) notFound();
  const admin = role === "admin" && viewer.role !== "limited";
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: c.libraryName, href: `/s/${serverId}/library/${c.libraryId}?view=collections` }, { label: c.name }]} className="-mb-2" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Layers className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{c.name}</h1>
          <p className="text-sm text-muted-foreground">
            {c.items.length === 1 ? "1 title" : `${c.items.length} titles`}
            {c.kind === "tmdb" ? " · a film series, kept up to date from TMDB" : ""}
          </p>
        </div>
        {admin && c.kind === "manual" && (
          <div className="ml-auto">
            <CollectionAdminBar serverId={serverId} libraryId={c.libraryId} id={c.id} name={c.name} />
          </div>
        )}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {c.items.map((t) => (
          <li key={t.id} className="group/item relative min-w-0">
            <PosterCard title={{ id: t.id, kind: t.kind, name: t.name, year: t.year, posterUrl: t.posterUrl }} serverId={serverId} />
            {admin && c.kind === "manual" && <RemoveFromCollectionButton collectionId={c.id} titleId={t.id} titleName={t.name} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
