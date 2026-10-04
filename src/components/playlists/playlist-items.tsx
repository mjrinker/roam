"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowUp, Film, GripVertical, Headphones, Loader2, Play, Tv, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { playlistApi, type ItemRow } from "@/components/playlists/playlist-api";
import { moveTo } from "@/components/playlists/reorder";

const KIND_LABEL = { movie: "Movie", show: "Show", audiobook: "Audiobook", episode: "Episode" } as const;

function kindOf(item: ItemRow): keyof typeof KIND_LABEL {
  return item.episodeId ? "episode" : (item.titleKind ?? "movie");
}

/** Where an item opens: movies/episodes play (carrying the queue), a show opens its page, a book its page. */
export function itemHref(serverId: string, playlistId: string, item: ItemRow): string {
  const queue = `?playlist=${playlistId}&item=${item.id}`;
  if (item.episodeId) return `/s/${serverId}/watch/episode/${item.episodeId}${queue}`;
  if (item.titleKind === "show") return `/s/${serverId}/show/${item.titleId}`;
  if (item.titleKind === "audiobook") return `/s/${serverId}/book/${item.titleId}${queue}`;
  return `/s/${serverId}/watch/title/${item.titleId}${queue}`;
}

function displayName(item: ItemRow): string {
  if (item.episodeId) {
    const code = `S${item.seasonNumber ?? "?"} · E${item.episodeNumber ?? "?"}`;
    return `${item.showName ?? "Episode"} — ${code}${item.name ? ` · ${item.name}` : ""}`;
  }
  return item.name ?? "Untitled";
}

export function PlaylistItems({
  serverId,
  playlistId,
  initialItems,
  initialCursor,
  canEdit,
}: {
  serverId: string;
  playlistId: string;
  initialItems: ItemRow[];
  initialCursor: string | null;
  canEdit: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Drag-and-drop (mouse): the row being dragged and the row it is currently over.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  async function loadMore() {
    setLoadingMore(true);
    const res = await playlistApi.items(playlistId, cursor);
    setLoadingMore(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setItems((cur) => [...cur, ...res.data.items.filter((n) => !cur.some((c) => c.id === n.id))]);
    setCursor(res.data.nextCursor);
  }

  async function remove(item: ItemRow) {
    setBusyId(item.id);
    const res = await playlistApi.removeItem(playlistId, item.id);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setItems((cur) => cur.filter((i) => i.id !== item.id));
  }

  /** Moves the item at `from` to index `to` among the loaded items (optimistic; undone if the server refuses). */
  async function moveItem(from: number, to: number) {
    const moved = moveTo(items, from, to);
    const item = items[from];
    if (!moved || !item) return;
    const before = items;
    setItems(moved.items);
    setBusyId(item.id);
    const res = await playlistApi.moveItem(playlistId, item.id, moved.afterId);
    setBusyId(null);
    if (!res.ok) {
      setItems(before);
      toast.error(res.error);
    }
  }

  if (items.length === 0) {
    return <p className="px-1 py-10 text-sm text-muted-foreground">Nothing here yet. Use “Add to playlist” on a movie, show or book.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <ol className="flex flex-col gap-1">
        {items.map((item, index) => {
          const kind = kindOf(item);
          const Icon = kind === "audiobook" ? Headphones : kind === "movie" ? Film : Tv;
          const href = itemHref(serverId, playlistId, item);
          const disabled = !item.playable;
          return (
            <li
              key={item.id}
              draggable={canEdit && busyId === null}
              onDragStart={(e) => {
                setDragFrom(index);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                if (dragOver !== index) setDragOver(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFrom;
                setDragFrom(null);
                setDragOver(null);
                if (from !== null) void moveItem(from, index);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={cn(
                "group/item flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-white/[0.05]",
                disabled && "opacity-60",
                dragFrom === index && "opacity-40",
                dragOver === index && dragFrom !== null && dragFrom !== index && "ring-2 ring-primary/60"
              )}
            >
              {canEdit && <GripVertical aria-hidden className="-mr-1.5 size-4 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing" />}
              <span className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <div className="relative aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-white/[0.08]">
                {item.posterUrl ? (
                  <Image src={item.posterUrl} alt="" fill sizes="40px" className="object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <Icon className="size-4 text-muted-foreground/50" />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {disabled ? (
                  <span className="truncate text-sm font-medium">{displayName(item)}</span>
                ) : (
                  <Link href={href} className="truncate text-sm font-medium hover:text-primary">
                    {displayName(item)}
                  </Link>
                )}
                <span className="text-xs text-muted-foreground">
                  {KIND_LABEL[kind]}
                  {item.year ? ` · ${item.year}` : ""}
                  {disabled ? " · nothing playable yet" : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {!disabled && kind !== "show" && (
                  <Link
                    href={href}
                    aria-label={`Play ${displayName(item)}`}
                    className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-primary"
                  >
                    <Play className="size-4" fill="currentColor" />
                  </Link>
                )}
                {canEdit && (
                  <>
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={index === 0 || busyId !== null}
                      onClick={() => void moveItem(index, index - 1)}
                      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowUp className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={index === items.length - 1 || busyId !== null}
                      onClick={() => void moveItem(index, index + 1)}
                      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowDown className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${displayName(item)}`}
                      disabled={busyId !== null}
                      onClick={() => void remove(item)}
                      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-destructive disabled:opacity-30"
                    >
                      <X className="size-4" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {cursor && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-2 flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-white/[0.06] text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09] disabled:opacity-60"
        >
          {loadingMore && <Loader2 className="size-4 animate-spin" />} Load more
        </button>
      )}
    </div>
  );
}
