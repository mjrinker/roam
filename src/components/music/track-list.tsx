"use client";

import { Loader2, Pause, Play, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/player/timeline";
import { shuffled } from "@/lib/music/list-queue";
import { Button } from "@/components/ui/button";
import { useAudioPlayer } from "@/components/audio/audio-player-provider";

export interface TrackListItem {
  id: string;
  name: string;
  discNumber: number | null;
  trackNumber: number | null;
  durationSeconds: number | null;
  artist: string | null;
}

/** Play and Shuffle for an album: queues every song so it carries on to the next one. */
export function AlbumPlayButtons({ ids }: { ids: string[] }) {
  const p = useAudioPlayer();
  const current = p?.book?.titleId;
  const inAlbum = !!current && ids.includes(current);
  const playing = inAlbum && p?.status === "playing";

  async function start(order: string[]) {
    if (!p) return;
    const result = await p.playList(order, 0);
    if (!result.ok) toast.error(result.error ?? "Couldn't start this album.");
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={!p || ids.length === 0}
        onClick={() => (inAlbum && p ? p.toggle() : start(ids))}
        className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
      >
        {playing ? <Pause className="size-5" fill="currentColor" /> : <Play className="size-5" fill="currentColor" />}
        {playing ? "Pause" : inAlbum ? "Resume" : "Play"}
      </Button>
      <Button variant="secondary" disabled={!p || ids.length === 0} onClick={() => start(shuffled(ids))} className="h-12 gap-2 rounded-xl px-5">
        <Shuffle className="size-4" /> Shuffle
      </Button>
    </div>
  );
}

/** The songs of an album, in order; clicking one plays from there and carries on through the rest. */
export function TrackList({ tracks }: { tracks: TrackListItem[] }) {
  const p = useAudioPlayer();
  const ids = tracks.map((t) => t.id);
  const multiDisc = new Set(tracks.map((t) => t.discNumber ?? 1)).size > 1;

  async function playFrom(index: number) {
    if (!p) return;
    if (p.book?.titleId === ids[index]) return p.toggle();
    const result = await p.playList(ids, index);
    if (!result.ok) toast.error(result.error ?? "Couldn't play this song.");
  }

  return (
    <ol className="flex flex-col">
      {tracks.map((t, i) => {
        const isCurrent = p?.book?.titleId === t.id;
        const playing = isCurrent && p?.status === "playing";
        const loading = isCurrent && p?.status === "loading";
        const heading = multiDisc && (i === 0 || t.discNumber !== tracks[i - 1].discNumber) ? `Disc ${t.discNumber ?? 1}` : null;
        return (
          <li key={t.id}>
            {heading && <p className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>}
            <button
              type="button"
              onClick={() => playFrom(i)}
              disabled={!p}
              className={cn(
                "group flex w-full items-center gap-4 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-primary",
                isCurrent && "bg-white/[0.06]"
              )}
            >
              <span className="flex w-6 shrink-0 justify-center text-sm text-muted-foreground tabular-nums">
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : playing ? (
                  <Pause className="size-4 text-primary" fill="currentColor" />
                ) : (
                  <>
                    <span className="group-hover:hidden group-focus-visible:hidden">{t.trackNumber ?? "–"}</span>
                    <Play className="hidden size-4 group-hover:block group-focus-visible:block" fill="currentColor" />
                  </>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm font-medium", isCurrent && "text-primary")}>{t.name}</span>
                {t.artist && <span className="block truncate text-xs text-muted-foreground">{t.artist}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t.durationSeconds != null ? formatClock(t.durationSeconds) : ""}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
