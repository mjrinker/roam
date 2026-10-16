import { Bookmark } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { listWatchlist } from "@/lib/watchlist/queries";
import { PosterCard } from "@/components/library/poster-card";

/** The movies, shows and audiobooks this profile means to get to (private to it; they leave the list once finished). */
export default async function WatchlistPage({ params }: PageProps<"/s/[serverId]/watchlist">) {
  const { serverId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const lib = libraryActor({ profile, role }, serverId);
  const items = await listWatchlist(db, { actor: lib, viewer, viewerId: viewer.id, serverId });
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Bookmark className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Watch list</h1>
          <p className="text-sm text-muted-foreground">{items.length === 1 ? "1 title" : `${items.length} titles`} · only you see this, and a title leaves it once you finish it</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="px-1 py-10 text-sm text-muted-foreground">Nothing here yet. Use the Watch list button on a movie, show or audiobook.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((t) => (
            <li key={t.id} className="min-w-0">
              <PosterCard title={{ id: t.id, kind: t.kind, name: t.name, year: t.year, posterUrl: t.posterUrl }} serverId={serverId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
