"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { PosterCard } from "@/components/library/poster-card";
import { AlbumTile, ArtistTile, TILE_GRID } from "@/components/music/music-cards";
import { SelectionBar, SelectOverlay, SelectToggle, useSelection } from "@/components/library/selection";
import { folderSortQuery, type FolderItem, type FolderSort } from "@/lib/libraries/folder-browse";
import type { AlbumCard, ArtistCard } from "@/lib/music/browse";
import { cn } from "@/lib/utils";

async function getIds(url: string): Promise<string[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Couldn't list everything here.");
  const body = (await res.json()) as { ids: string[]; truncated: boolean };
  if (body.truncated) toast.message(`That is a lot: only the first ${body.ids.length.toLocaleString()} were taken.`);
  return body.ids;
}

/** The selected ids in the order the page lists them (the whole list when it has been read), then any others. */
function inOrder(selected: ReadonlySet<string>, shown: readonly string[], whole: readonly string[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(whole ?? []), ...shown, ...selected]) {
    if (selected.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The files of one folder of a video or audio library, with Select: choose some, or "Select all in this folder" (every page of it, not
 * only the ones loaded), then add them to a playlist or download them.
 */
export function SelectableFolderItems({ serverId, libraryId, path, items, itemKind, sort, search = null }: { serverId: string; libraryId: string; path: string; items: FolderItem[]; itemKind: "movie" | "audiobook"; sort: FolderSort; search?: string | null }) {
  const sel = useSelection();
  const [whole, setWhole] = useState<string[] | null>(null);
  const [reading, setReading] = useState(false);
  const shown = useMemo(() => items.map((i) => i.id), [items]);

  const resolve = useCallback(async () => inOrder(sel.selected, shown, whole), [sel.selected, shown, whole]);
  async function selectAll() {
    setReading(true);
    try {
      const ids = await getIds(`/api/libraries/${libraryId}/folder-ids?${folderSortQuery(sort)}${search ? `q=${encodeURIComponent(search)}&` : ""}path=${encodeURIComponent(path)}`);
      setWhole(ids);
      sel.selectMany(ids);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setReading(false);
  }
  const allSelected = whole !== null && whole.every((id) => sel.selected.has(id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <SelectToggle selecting={sel.selecting} onClick={() => (sel.selecting ? sel.stop() : sel.setSelecting(true))} />
      </div>
      {sel.selecting && (
        <SelectionBar
          serverId={serverId}
          count={sel.selected.size}
          selectAllLabel={search ? "Select all results" : "Select all in this folder"}
          allSelected={allSelected}
          selectingAll={reading}
          onSelectAll={selectAll}
          onClear={sel.clear}
          onDone={sel.stop}
          resolve={resolve}
        />
      )}
      <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {items.map((item, index) => (
          <li key={item.id} className="relative min-w-0">
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
            {sel.selecting && <SelectOverlay name={item.name} checked={sel.selected.has(item.id)} onToggle={(shift) => sel.toggle(items, index, shift)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A music library's Artists or Albums tab with Select: choose some, or "Select all" (every page), then add their songs to a playlist or
 * download them. The actions work on songs: an album stands for its songs and an artist for all of theirs.
 */
export function SelectableMusicTiles({ serverId, libraryId, view, albums, artists }: { serverId: string; libraryId: string; view: "albums" | "artists"; albums: AlbumCard[] | null; artists: ArtistCard[] | null }) {
  const sel = useSelection();
  const [whole, setWhole] = useState<string[] | null>(null);
  const [reading, setReading] = useState(false);
  const cards: { id: string; name: string }[] = useMemo(() => (view === "albums" ? (albums ?? []) : (artists ?? [])), [view, albums, artists]);
  const shown = useMemo(() => cards.map((c) => c.id), [cards]);

  // The albums or artists chosen become their songs only when an action needs them.
  const resolve = useCallback(async () => {
    const chosen = inOrder(sel.selected, shown, whole);
    const res = await fetch(`/api/libraries/${libraryId}/music-songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(view === "albums" ? { albumIds: chosen } : { artistIds: chosen }),
    });
    if (!res.ok) throw new Error("Couldn't list the songs.");
    const body = (await res.json()) as { ids: string[]; truncated: boolean };
    if (body.truncated) toast.message(`That is a lot of songs: only the first ${body.ids.length.toLocaleString()} are included.`);
    return body.ids;
  }, [sel.selected, shown, whole, libraryId, view]);

  async function selectAll() {
    setReading(true);
    try {
      const ids = await getIds(`/api/libraries/${libraryId}/music-ids?view=${view}`);
      setWhole(ids);
      sel.selectMany(ids);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setReading(false);
  }
  const allSelected = whole !== null && whole.every((id) => sel.selected.has(id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <SelectToggle selecting={sel.selecting} onClick={() => (sel.selecting ? sel.stop() : sel.setSelecting(true))} />
      </div>
      {sel.selecting && (
        <SelectionBar
          serverId={serverId}
          count={sel.selected.size}
          selectAllLabel={view === "albums" ? "Select all albums" : "Select all artists"}
          allSelected={allSelected}
          selectingAll={reading}
          onSelectAll={selectAll}
          onClear={sel.clear}
          onDone={sel.stop}
          resolve={resolve}
        />
      )}
      <div className={TILE_GRID}>
        {view === "albums"
          ? albums?.map((a, index) => (
              <div key={a.id} className={cn("relative min-w-0")}>
                <AlbumTile serverId={serverId} album={a} />
                {sel.selecting && <SelectOverlay name={a.name} checked={sel.selected.has(a.id)} onToggle={(shift) => sel.toggle(cards, index, shift)} />}
              </div>
            ))
          : artists?.map((a, index) => (
              <div key={a.id} className="relative min-w-0">
                <ArtistTile serverId={serverId} artist={a} />
                {sel.selecting && <SelectOverlay name={a.name} checked={sel.selected.has(a.id)} onToggle={(shift) => sel.toggle(cards, index, shift)} round />}
              </div>
            ))}
      </div>
    </div>
  );
}
