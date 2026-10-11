import { notFound } from "next/navigation";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { loadContributor, type ContributorBook } from "@/lib/audiobooks/credits";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { InitialsAvatar } from "@/components/library/audiobook-views";
import { PosterCard } from "@/components/library/poster-card";

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch {
    return null;
  }
}

/** An author or narrator, and the audiobooks on this server they wrote or narrated. */
export default async function ContributorPage({ params }: PageProps<"/s/[serverId]/contributor/[name]">) {
  const { serverId, name: rawName } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const name = safeDecode(rawName);
  if (!name) notFound();
  const person = await loadContributor(db, libraryActor({ profile, role }, serverId), viewer, name);
  if (!person) notFound();
  const total = new Set([...person.written, ...person.narrated].map((b) => b.id)).size;
  return (
    <div className="flex flex-col gap-8 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: person.name }]} className="-mb-4" />
      <header className="flex items-center gap-5">
        <InitialsAvatar name={person.name} className="size-24 shrink-0 text-3xl sm:size-32 sm:text-4xl" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{person.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} {total === 1 ? "book" : "books"} on this server
          </p>
        </div>
      </header>
      <BookSection serverId={serverId} heading="Written by" books={person.written} />
      <BookSection serverId={serverId} heading="Narrated by" books={person.narrated} />
    </div>
  );
}

function BookSection({ serverId, heading, books }: { serverId: string; heading: string; books: ContributorBook[] }) {
  if (books.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">
        {heading} <span className="text-sm font-normal text-muted-foreground">{books.length}</span>
      </h2>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {books.map((b) => (
          <li key={b.id} className="min-w-0">
            <PosterCard serverId={serverId} title={{ id: b.id, kind: "audiobook", name: b.name, year: b.year, posterUrl: b.posterUrl, subtitle: b.seriesName ? `${b.seriesName}${b.seriesPosition ? ` · Book ${b.seriesPosition}` : ""}` : null }} />
          </li>
        ))}
      </ul>
    </section>
  );
}
