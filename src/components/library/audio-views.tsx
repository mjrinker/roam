import Link from "next/link";
import { Disc3, Music, Tags, UserRound } from "lucide-react";
import { Artwork as Image } from "@/components/ui/artwork";
import { SelectableFolderItems } from "@/components/library/selectable-views";
import { FolderToolbar } from "@/components/library/folder-toolbar";
import { LazyPlayButtons } from "@/components/library/lazy-play-buttons";
import { type AudioGroup, type GroupKind } from "@/lib/libraries/audio-groups";
import { folderSortQuery, type FolderItem, type FolderSort } from "@/lib/libraries/folder-browse";

export type SongView = "songs" | "artists" | "albums" | "genres" | "folders";

/** The views a song library (music or generic audio) offers, in order, and what each is called there. */
const TABS: Record<"music" | "audio", { view: SongView; label: string }[]> = {
  music: [
    { view: "artists", label: "Artists" },
    { view: "albums", label: "Albums" },
    { view: "songs", label: "Songs" },
    { view: "genres", label: "Genres" },
  ],
  audio: [
    { view: "songs", label: "Tracks" },
    { view: "artists", label: "Artists" },
    { view: "albums", label: "Albums" },
    { view: "genres", label: "Genres" },
    { view: "folders", label: "Folders" },
  ],
};

/** The view a song library opens to (the first tab). */
export const defaultSongView = (kind: "music" | "audio"): SongView => TABS[kind][0].view;

/** The view named in an address, if this library has it; else the library's first. */
export function parseSongView(kind: "music" | "audio", raw: string | null | undefined): SongView {
  return TABS[kind].find((t) => t.view === raw)?.view ?? defaultSongView(kind);
}

export function songViewName(kind: "music" | "audio", view: SongView): string {
  return TABS[kind].find((t) => t.view === view)?.label ?? "Songs";
}

/** The toggle between a song library's views. */
export function SongViewTabs({ serverId, libraryId, kind, active }: { serverId: string; libraryId: string; kind: "music" | "audio"; active: SongView }) {
  const base = `/s/${serverId}/library/${libraryId}`;
  return (
    <nav aria-label="Views" className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
      {TABS[kind].map((t) => (
        <Link
          key={t.view}
          href={t.view === defaultSongView(kind) ? base : `${base}?view=${t.view}`}
          aria-current={active === t.view ? "page" : undefined}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${active === t.view ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

const GROUP_NOUN: Record<GroupKind, string> = { artist: "artist", album: "album", genre: "genre" };
const GROUP_VIEW: Record<GroupKind, SongView> = { artist: "artists", album: "albums", genre: "genres" };

/** The artists, albums or genres of a song library as tiles; opening one lists its songs. */
export function AudioGroupGrid({ serverId, libraryId, kind, groups, nextHref }: { serverId: string; libraryId: string; kind: GroupKind; groups: AudioGroup[]; nextHref: string | null }) {
  const base = `/s/${serverId}/library/${libraryId}`;
  const Icon = kind === "artist" ? UserRound : kind === "album" ? Disc3 : Tags;
  return (
    <div className="flex flex-col gap-6">
      {groups.length === 0 ? (
        <p className="rounded-xl bg-white/[0.04] px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">
          No {GROUP_NOUN[kind]}s yet. They appear once the files&apos; tags have been read.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {groups.map((g) => (
            <li key={g.name} className="min-w-0">
              <Link href={`${base}?view=${GROUP_VIEW[kind]}&group=${encodeURIComponent(g.name)}`} className="group/card flex flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <div className={`relative aspect-square overflow-hidden bg-muted ring-1 ring-white/[0.08] transition duration-300 group-hover/card:-translate-y-1 group-hover/card:ring-white/25 ${kind === "artist" ? "rounded-full" : "rounded-xl"}`}>
                  {g.coverUrl ? (
                    <Image src={g.coverUrl} alt="" fill sizes="(min-width: 1024px) 200px, 45vw" className="object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-background">
                      <Icon className="size-1/3 text-muted-foreground/60" />
                    </div>
                  )}
                </div>
                <div className={`min-w-0 ${kind === "artist" ? "text-center" : ""}`}>
                  <p className="truncate text-sm font-medium">{g.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {g.count} {g.count === 1 ? "song" : "songs"}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextHref && (
        <Link href={nextHref} className="w-fit rounded-xl bg-white/[0.08] px-5 py-2.5 text-sm font-medium hover:bg-white/[0.14]">
          Show more
        </Link>
      )}
    </div>
  );
}

/**
 * A list of songs - the whole library's, or one artist's, album's or genre's - with search, sort, Play and Shuffle for the whole list
 * (not just the page shown), and Select. `extra` is the address part that says which list this is (view and group).
 */
export function SongsView({
  serverId,
  libraryId,
  extra,
  group,
  items,
  sort,
  search,
  nextHref,
}: {
  serverId: string;
  libraryId: string;
  extra: string;
  group: { kind: GroupKind; label: string; name: string } | null;
  items: FolderItem[];
  sort: FolderSort;
  search: string | null;
  nextHref: string | null;
}) {
  const base = `/s/${serverId}/library/${libraryId}`;
  const scope = `all=1&${group ? `groupKind=${group.kind}&group=${encodeURIComponent(group.name)}&` : ""}`;
  const idsQuery = `${scope}${folderSortQuery(sort)}${search ? `q=${encodeURIComponent(search)}&` : ""}`;
  return (
    <div className="flex flex-col gap-6">
      {group && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{GROUP_NOUN[group.kind]}</p>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Music className="size-5 text-primary" /> {group.label}
          </h2>
          <Link href={`${base}?view=${GROUP_VIEW[group.kind]}`} className="w-fit text-sm text-muted-foreground hover:text-foreground">
            All {GROUP_NOUN[group.kind]}s
          </Link>
        </div>
      )}
      <LazyPlayButtons idsUrl={`/api/libraries/${libraryId}/folder-ids?${idsQuery}`.replace(/&$/, "")} />
      <FolderToolbar base={base} extra={extra} path="" sort={sort} q={search} />
      {search && <p className="text-sm text-muted-foreground">Results for &ldquo;{search}&rdquo;.</p>}
      {items.length === 0 ? (
        <p className="rounded-xl bg-white/[0.04] px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">
          {search ? `No songs match “${search}”.` : "No songs here yet."}
        </p>
      ) : (
        <SelectableFolderItems serverId={serverId} libraryId={libraryId} path="" items={items} itemKind="audiobook" sort={sort} search={search} listQuery={scope} />
      )}
      {nextHref && (
        <Link href={nextHref} className="mx-auto flex h-10 items-center rounded-xl bg-white/[0.06] px-6 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]">
          Load more
        </Link>
      )}
    </div>
  );
}
