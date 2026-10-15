import Link from "next/link";
import { Layers } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import type { CollectionCard } from "@/lib/collections/queries";

export type LibraryView = "titles" | "collections";
export const parseLibraryView = (raw: string | null | undefined): LibraryView => (raw === "collections" ? "collections" : "titles");

/** The titles | Collections switch on a movies or shows library. */
export function CollectionViewTabs({ serverId, libraryId, active, titlesLabel }: { serverId: string; libraryId: string; active: LibraryView; titlesLabel: string }) {
  const base = `/s/${serverId}/library/${libraryId}`;
  const tab = (view: LibraryView, label: string) => (
    <Link
      href={view === "titles" ? base : `${base}?view=${view}`}
      aria-current={active === view ? "page" : undefined}
      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${active === view ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Views" className="flex w-fit gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
      {tab("titles", titlesLabel)}
      {tab("collections", "Collections")}
    </nav>
  );
}

export function CollectionGrid({ serverId, collections }: { serverId: string; collections: CollectionCard[] }) {
  if (collections.length === 0) {
    return <p className="rounded-xl bg-white/[0.04] px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">No collections yet.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {collections.map((c) => (
        <li key={c.id} className="min-w-0">
          <Link href={`/s/${serverId}/collection/${c.id}`} className="group/card block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <span className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-muted ring-1 ring-white/[0.08] transition duration-300 group-hover/card:-translate-y-1 group-hover/card:ring-white/25">
              {c.posterUrl ? (
                <Image src={c.posterUrl} alt="" fill sizes="(min-width: 1024px) 200px, 45vw" className="object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-background"><Layers className="size-8 text-muted-foreground/60" /></span>
              )}
              <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium backdrop-blur">{c.count}</span>
            </span>
            <span className="mt-2 block min-w-0">
              <span className="line-clamp-2 block text-sm leading-snug font-medium">{c.name}</span>
              <span className="block text-xs text-muted-foreground">{c.count === 1 ? "1 title" : `${c.count} titles`}{c.kind === "tmdb" ? " · series" : ""}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
