import Link from "next/link";
import { Tag } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { visibleLabels } from "@/lib/labels/queries";

/** The profile's own labels on this server, with how many titles each has. */
export default async function LabelsPage({ params }: PageProps<"/s/[serverId]/labels">) {
  const { serverId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);
  const labels = await visibleLabels(db, { actor: lib, viewer, viewerId: viewer.id, serverId });
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Tag className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Labels</h1>
          <p className="text-sm text-muted-foreground">Your own tags for movies, shows and books. Only you see them. Add one with the Labels button on a title&apos;s page.</p>
        </div>
      </div>
      {labels.length === 0 ? (
        <p className="px-1 py-10 text-sm text-muted-foreground">No labels yet. Use the Labels button on a movie, show or book to make one.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {labels.map((l) => (
            <li key={l.id}>
              <Link href={`/s/${serverId}/labels/${l.id}`} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08] transition hover:bg-white/[0.07]">
                <span className="truncate font-medium">{l.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{l.count === 1 ? "1 title" : `${l.count} titles`}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
