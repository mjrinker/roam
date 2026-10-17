import { notFound } from "next/navigation";
import { Tag } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { isUuid } from "@/lib/playlists/http";
import { labelWithTitles } from "@/lib/labels/queries";
import { PosterCard } from "@/components/library/poster-card";
import { LabelActions } from "@/components/labels/label-actions";

/** One of the profile's labels and the titles under it that it can see. */
export default async function LabelPage({ params }: PageProps<"/s/[serverId]/labels/[id]">) {
  const { serverId, id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);
  const label = await labelWithTitles(db, { actor: lib, viewer, viewerId: viewer.id, serverId }, id);
  if (!label) notFound();
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Tag className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{label.name}</h1>
          <p className="text-sm text-muted-foreground">{label.titles.length === 1 ? "1 title" : `${label.titles.length} titles`} · only you see this label</p>
        </div>
        <div className="ml-auto">
          <LabelActions serverId={serverId} id={label.id} name={label.name} />
        </div>
      </div>
      {label.titles.length === 0 ? (
        <p className="px-1 py-10 text-sm text-muted-foreground">Nothing under this label that you can see.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {label.titles.map((t) => (
            <li key={t.id} className="min-w-0">
              <PosterCard title={{ id: t.id, kind: t.kind, name: t.name, year: t.year, posterUrl: t.posterUrl }} serverId={serverId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
