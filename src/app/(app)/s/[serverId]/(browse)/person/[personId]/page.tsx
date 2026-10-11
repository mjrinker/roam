import { notFound } from "next/navigation";
import { User } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { loadPersonPage } from "@/lib/cast/queries";
import { loadPersonInfo } from "@/lib/cast/person-info";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PosterCard } from "@/components/library/poster-card";

/** A person from a cast list, and the movies and shows on this server they appear in. */
export default async function PersonPage({ params }: PageProps<"/s/[serverId]/person/[personId]">) {
  const { serverId, personId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  if (!/^\d{1,9}$/.test(personId)) notFound();
  const person = await loadPersonPage(db, libraryActor({ profile, role }, serverId), viewer, Number(personId));
  if (!person) notFound();
  // A profile with an age limit isn't shown work that is not on the server: TMDB's credits carry no ratings to check it against.
  const info = await loadPersonInfo(db, serverId, person.personId, { includeOffServer: viewer.maxAge == null });
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
          {info && (info.born || info.died) && <p className="mt-1 text-sm text-muted-foreground">{[info.born, info.died].filter(Boolean).join(" · ")}</p>}
        </div>
      </header>
      {info?.bio && <Biography text={info.bio} />}
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {person.items.map((item) => (
          <li key={item.id} className="min-w-0">
            <PosterCard serverId={serverId} title={{ id: item.id, kind: item.kind, name: item.name, year: item.year, posterUrl: item.posterUrl, subtitle: [item.year, ...item.roles].filter(Boolean).join(" · ") || null }} />
          </li>
        ))}
      </ul>
      {info && info.offServer.length > 0 && (
        <section aria-label="Not on this server" className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Not on this server</h2>
            <p className="text-sm text-muted-foreground">Other work of theirs. These open on The Movie Database.</p>
          </div>
          <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">
            {info.offServer.map((o) => (
              <li key={o.key} className="min-w-0">
                <a href={o.href} target="_blank" rel="noreferrer" className="group/off block outline-none">
                  <span className="relative block aspect-[2/3] overflow-hidden rounded-lg bg-muted opacity-70 ring-1 ring-white/[0.08] transition group-hover/off:opacity-100 group-focus-visible/off:ring-2 group-focus-visible/off:ring-primary">
                    <Image src={o.posterUrl} alt="" fill sizes="(min-width: 1024px) 140px, 30vw" className="object-cover" />
                  </span>
                  <span className="mt-1.5 line-clamp-2 block text-xs leading-snug font-medium">{o.title}</span>
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{[o.year, ...o.roles].filter(Boolean).join(" · ")}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A person's biography: the first part, with the rest one click away when it is long. */
function Biography({ text }: { text: string }) {
  const LIMIT = 520;
  if (text.length <= LIMIT) return <p className="max-w-3xl text-[15px] leading-relaxed whitespace-pre-line text-foreground/80">{text}</p>;
  const cut = text.slice(0, LIMIT).replace(/\s+\S*$/, "");
  return (
    <details className="group max-w-3xl">
      <summary className="cursor-pointer list-none text-[15px] leading-relaxed text-foreground/80 marker:hidden">
        <span className="group-open:hidden">
          {cut}… <span className="font-medium text-primary">Read more</span>
        </span>
        <span className="hidden whitespace-pre-line group-open:inline">{text}</span>
      </summary>
    </details>
  );
}
