import Link from "next/link";
import { Folder, FolderOpen } from "lucide-react";
import { PosterCard } from "@/components/library/poster-card";
import { PhotoTile } from "@/components/photos/photo-tile";
import { SelectableFolderItems } from "@/components/library/selectable-views";
import { DEFAULT_FOLDER_SORT, folderLink, folderTrail, parentFolder, type FolderItem, type FolderSort } from "@/lib/libraries/folder-browse";
import { FolderToolbar } from "@/components/library/folder-toolbar";

/** One level of a video library, file-manager style: breadcrumbs, subfolders, then the videos in this folder. */
export function VideoFolderView({
  serverId,
  libraryId,
  libraryName,
  path,
  folders,
  items,
  nextHref,
  itemKind = "movie",
  extraQuery,
  sort = DEFAULT_FOLDER_SORT,
  sortable = false,
  search = null,
}: {
  serverId: string;
  libraryId: string;
  libraryName: string;
  /** The current folder, '' at the library root. */
  path: string;
  folders: string[];
  items: FolderItem[];
  /** Link to the next page of videos, or null. */
  nextHref: string | null;
  /** What each item is: a video plays like a movie (poster card, /title), an audio file like an audiobook (square card, /book). */
  itemKind?: "movie" | "audiobook" | "photo" | "ebook";
  /** Kept on every link (a photo library's `view=albums`). */
  extraQuery?: string;
  /** How the files are ordered (by name when omitted). */
  sort?: FolderSort;
  /** Whether to offer the Sort by choices (a generic Audio library). */
  sortable?: boolean;
  /** A search through the whole library (instead of one folder), when there is one. */
  search?: string | null;
}) {
  const base = `/s/${serverId}/library/${libraryId}`;
  const extra = extraQuery ? `${extraQuery}&` : "";
  // A link to a folder (or this one) with a given sort kept, so choosing a sort or going into a folder doesn't lose it.
  const link = (p: string, s: FolderSort) => folderLink({ base, extra, path: p, sort: s });
  const at = (p: string) => link(p, sort);
  const parent = parentFolder(path);
  const trail = folderTrail(path);
  const empty = folders.length === 0 && items.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {sortable && <FolderToolbar base={base} extra={extra} path={path} sort={sort} q={search} />}

      {search && (
        <p className="text-sm text-muted-foreground">
          Results for &ldquo;{search}&rdquo; across the whole library.
        </p>
      )}

      {!search && (
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <Link href={at("")} className={path === "" ? "font-medium text-foreground" : "hover:text-foreground"}>
          {libraryName}
        </Link>
        {trail.map((crumb, i) => (
          <span key={crumb.path} className="flex items-center gap-1.5">
            <span aria-hidden>/</span>
            {i === trail.length - 1 ? (
              <span className="font-medium text-foreground">{crumb.name}</span>
            ) : (
              <Link href={at(crumb.path)} className="hover:text-foreground">
                {crumb.name}
              </Link>
            )}
          </span>
        ))}
      </nav>
      )}

      {!search && parent !== null && (
        <Link href={at(parent)} className="flex w-fit items-center gap-2 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-white/[0.06] hover:text-foreground">
          <FolderOpen className="size-4" /> Up one level
        </Link>
      )}

      {!search && folders.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {folders.map((name) => (
            <li key={name}>
              <Link
                href={at(path === "" ? name : `${path}/${name}`)}
                className="flex items-center gap-3 rounded-xl bg-white/[0.05] px-3 py-3 ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]"
              >
                <Folder className="size-5 shrink-0 text-primary" />
                <span className="min-w-0 truncate text-sm font-medium">{name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && itemKind === "photo" && (
        <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {items.map((item, i) => (
            <li key={item.id} className="min-w-0">
              <PhotoTile
                serverId={serverId}
                item={{ id: item.id, kind: item.kind === "photo" ? "photo" : "movie", name: item.name, posterUrl: item.posterUrl, runtimeSeconds: item.runtimeSeconds, favorite: item.favorite }}
                from={`from=album&path=${encodeURIComponent(path)}`}
                priority={i < 12}
              />
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (itemKind === "movie" || itemKind === "audiobook") && <SelectableFolderItems serverId={serverId} libraryId={libraryId} path={path} items={items} itemKind={itemKind} sort={sort} search={search} />}

      {items.length > 0 && itemKind === "ebook" && (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => (
            <li key={item.id} className="min-w-0">
              <PosterCard
                serverId={serverId}
                title={{
                  id: item.id,
                  kind: itemKind,
                  name: item.name,
                  year: item.year,
                  posterUrl: item.posterUrl,
                  subtitle: item.authors && item.authors.length > 0 ? item.authors.join(", ") : null,
                  watched: item.watched,
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {empty && (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-24 text-center">
          <Folder className="size-8 text-muted-foreground/60" />
          <p className="text-lg font-medium">Nothing here</p>
          <p className="text-sm text-muted-foreground">{search ? `No files match “${search}”.` : "There is nothing in this folder yet."}</p>
        </div>
      )}

      {nextHref && (
        <Link href={nextHref} className="mx-auto flex h-10 items-center rounded-xl bg-white/[0.06] px-6 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]">
          Load more
        </Link>
      )}
    </div>
  );
}
