import { MediaRow } from "@/components/library/media-row";
import { PosterCard } from "@/components/library/poster-card";
/** A title on a shelf. */
export interface ShelfItem {
  id: string;
  kind: "movie" | "show" | "audiobook";
  name: string;
  year: number | null;
  posterUrl: string | null;
}

/** A shelf of titles: "More like this" on a title page, "Recommended for you" and "Because you liked X" on the home page. */
export function TitleShelf({ serverId, title, items, href }: { serverId: string; title: string; items: ShelfItem[]; /** Where "see all" goes. */ href?: string }) {
  if (items.length === 0) return null;
  return (
    <MediaRow title={title} href={href}>
      {items.map((t) => (
        <PosterCard key={t.id} serverId={serverId} title={{ id: t.id, kind: t.kind, name: t.name, year: t.year, posterUrl: t.posterUrl }} className="w-36 sm:w-40 lg:w-44" />
      ))}
    </MediaRow>
  );
}
