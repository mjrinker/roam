import Link from "next/link";
import { User } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import type { CrewMember } from "@/lib/cast/queries";

/** The key crew of a movie or show (director, writers, producers ...) as a scrolling row; each links to that person's page. */
export function CrewRow({ serverId, crew }: { serverId: string; crew: CrewMember[] }) {
  if (crew.length === 0) return null;
  return (
    <section aria-label="Crew" className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pt-8 sm:px-8">
      <h2 className="text-lg font-semibold tracking-tight">Crew</h2>
      <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-8 sm:px-8">
        {crew.map((p) => (
          <li key={p.personId} className="w-28 shrink-0 sm:w-32">
            <Link href={`/s/${serverId}/person/${p.personId}`} className="group/crew flex flex-col gap-2 outline-none">
              <span className="relative block aspect-square overflow-hidden rounded-full bg-muted ring-1 ring-white/[0.08] transition group-hover/crew:ring-white/30 group-focus-visible/crew:ring-2 group-focus-visible/crew:ring-primary">
                {p.photoUrl ? (
                  <Image src={p.photoUrl} alt="" fill sizes="128px" className="object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-muted-foreground/60">
                    <User className="size-8" />
                  </span>
                )}
              </span>
              <span className="min-w-0 text-center">
                <span className="line-clamp-2 block text-sm leading-snug font-medium">{p.name}</span>
                <span className="line-clamp-2 mt-0.5 block text-xs text-muted-foreground">{p.jobs.join(", ")}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
