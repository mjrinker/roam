import Link from "next/link";
import { Artwork as Image } from "@/components/ui/artwork";
import { contributorHref, type AuthorTile } from "@/lib/audiobooks/credits";

export type AudiobookView = "books" | "authors";

export const parseAudiobookView = (raw: string | null | undefined): AudiobookView => (raw === "authors" ? "authors" : "books");

const TABS: { view: AudiobookView; label: string }[] = [
  { view: "books", label: "Books" },
  { view: "authors", label: "Authors" },
];

/** The Books | Authors switch on an audiobook library. */
export function AudiobookViewTabs({ serverId, libraryId, active }: { serverId: string; libraryId: string; active: AudiobookView }) {
  const base = `/s/${serverId}/library/${libraryId}`;
  return (
    <nav aria-label="Views" className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
      {TABS.map((t) => (
        <Link
          key={t.view}
          href={t.view === "books" ? base : `${base}?view=${t.view}`}
          aria-current={active === t.view ? "page" : undefined}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${active === t.view ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** One or two initials for a name with no picture. */
export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** A round stand-in for a person's photo: their initials. */
export function InitialsAvatar({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={`flex items-center justify-center rounded-full bg-gradient-to-br from-secondary via-muted to-background font-semibold text-muted-foreground ring-1 ring-white/[0.08] ${className}`}>
      {initialsOf(name)}
    </span>
  );
}

/** The authors of an audiobook library as tiles; opening one shows everything that person is credited with on the server. */
export function AuthorGrid({ serverId, authors }: { serverId: string; authors: AuthorTile[] }) {
  if (authors.length === 0) {
    return <p className="rounded-xl bg-white/[0.04] px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">No authors yet.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {authors.map((a) => (
        <li key={a.key} className="min-w-0">
          <Link href={contributorHref(serverId, a.name)} className="group/card flex flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <span className="relative block aspect-square overflow-hidden rounded-full bg-muted ring-1 ring-white/[0.08] transition duration-300 group-hover/card:-translate-y-1 group-hover/card:ring-white/25">
              {a.coverUrl ? <Image src={a.coverUrl} alt="" fill sizes="(min-width: 1024px) 200px, 45vw" className="object-cover" /> : <InitialsAvatar name={a.name} className="size-full text-3xl" />}
            </span>
            <span className="min-w-0 text-center">
              <span className="line-clamp-2 block text-sm leading-snug font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{a.books === 1 ? "1 book" : `${a.books} books`}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The credits of a book: its authors and narrators (a full cast lists many), each linking to what else they are credited with. */
export function BookCredits({ serverId, authors, narrators }: { serverId: string; authors: string[]; narrators: string[] }) {
  const people = [...authors.map((name) => ({ name, role: "Author" })), ...narrators.map((name) => ({ name, role: narrators.length > 3 ? "Cast" : "Narrator" }))];
  // The same person can be both; one card with both roles.
  const merged = new Map<string, { name: string; roles: string[] }>();
  for (const p of people) {
    const k = p.name.trim().replace(/\s+/g, " ").toLowerCase();
    const have = merged.get(k) ?? { name: p.name, roles: [] };
    if (!have.roles.includes(p.role)) have.roles.push(p.role);
    merged.set(k, have);
  }
  if (merged.size === 0) return null;
  return (
    <section aria-label="Credits">
      <h2 className="mb-3 text-lg font-semibold">Credits</h2>
      <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-8 sm:px-8">
        {[...merged.values()].map((p) => (
          <li key={p.name} className="w-28 shrink-0 sm:w-32">
            <Link href={contributorHref(serverId, p.name)} className="group/credit flex flex-col gap-2 outline-none">
              <InitialsAvatar name={p.name} className="aspect-square w-full text-2xl transition group-hover/credit:ring-white/30 group-focus-visible/credit:ring-2 group-focus-visible/credit:ring-primary" />
              <span className="min-w-0 text-center">
                <span className="line-clamp-2 block text-sm leading-snug font-medium">{p.name}</span>
                <span className="block text-xs text-muted-foreground">{p.roles.join(", ")}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
