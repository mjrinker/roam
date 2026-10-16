import { MediaRow } from "@/components/library/media-row";
import { PosterCard } from "@/components/library/poster-card";
import type { Rec } from "@/lib/recommend/service";

/** A shelf of titles: "More like this" on a title page, "Recommended for you" and "Because you liked X" on the home page. */
export function TitleShelf({ serverId, title, items }: { serverId: string; title: string; items: Rec[] }) {
  if (items.length === 0) return null;
  return (
    <MediaRow title={title}>
      {items.map((t) => (
        <PosterCard key={t.id} serverId={serverId} title={{ id: t.id, kind: t.kind, name: t.name, year: t.year, posterUrl: t.posterUrl }} className="w-36 sm:w-40 lg:w-44" />
      ))}
    </MediaRow>
  );
}
