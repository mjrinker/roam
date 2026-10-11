import { notFound } from "next/navigation";
import { User } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { loadPersonPage } from "@/lib/cast/queries";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PosterCard } from "@/components/library/poster-card";

/** A person from a cast list, and the movies and shows on this server they appear in. */
export default async function PersonPage({ params }: PageProps<"/s/[serverId]/person/[personId]">) {
  const { serverId, personId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  if (!/^\d{1,9}$/.test(personId)) notFound();
  const person = await loadPersonPage(db, libraryActor({ profile, role }, serverId), viewer, Number(personId));
  if (!person) notFound();
  return (
    <div className="flex flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: person.name }]} className="-mb-4" />
      <header className="flex items-center gap-5">
        <span className="relative block size-24 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-white/[0.08] sm:size-32">
          {person.photoUrl ? (
            <Image src={person.photoUrl} alt="" fill sizes="128px" className="object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-muted-foreground/60">
              <User className="size-10" />
            </span>
          )}
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{person.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {person.items.length} {person.items.length === 1 ? "title" : "titles"} on this server
          </p>
        </div>
      </header>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {person.items.map((item) => (
          <li key={item.id} className="min-w-0">
            <PosterCard serverId={serverId} title={{ id: item.id, kind: item.kind, name: item.name, year: item.year, posterUrl: item.posterUrl, subtitle: [item.year, item.character ? `as ${item.character}` : null].filter(Boolean).join(" · ") || null }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
