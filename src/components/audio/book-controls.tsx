"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/player/timeline";
import { Button } from "@/components/ui/button";
import { useAudioActions, useAudioPlayer } from "@/components/audio/audio-player-provider";

/** Play / Resume / Pause for a book. Starts playback in the persistent player without leaving the page. */
export function BookPlayButton({ titleId, hasProgress }: { titleId: string; hasProgress: boolean }) {
  const p = useAudioPlayer();
  const [starting, setStarting] = useState(false);

  const isCurrent = p?.book?.titleId === titleId;
  const playing = isCurrent && p?.status === "playing";
  const busy = starting || (isCurrent && p?.status === "loading");

  async function onClick() {
    if (!p) return;
    if (isCurrent) return p.toggle();
    setStarting(true);
    const result = await p.load(titleId, { autoplay: true });
    setStarting(false);
    if (!result.ok) toast.error(result.error ?? "Couldn't start this audiobook.");
  }

  return (
    <Button
      onClick={onClick}
      disabled={!p || busy}
      className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
    >
      {busy ? (
        <Loader2 className="size-5 animate-spin" />
      ) : playing ? (
        <Pause className="size-5" fill="currentColor" />
      ) : (
        <Play className="size-5" fill="currentColor" />
      )}
      {playing ? "Pause" : hasProgress || isCurrent ? "Resume" : "Play"}
    </Button>
  );
}

export interface BookChapterRow {
  title: string;
  startSeconds: number;
}

/** Chapter list for a book. Clicking a chapter starts (or jumps to) it in the persistent player. */
export function BookChapters({
  titleId,
  chapters,
  totalSeconds,
}: {
  titleId: string;
  chapters: BookChapterRow[];
  totalSeconds: number;
}) {
  const p = useAudioPlayer();
  const isCurrent = p?.book?.titleId === titleId;

  async function open(index: number) {
    if (!p) return;
    if (isCurrent) {
      p.jumpToChapter(index);
      p.play();
      return;
    }
    const result = await p.load(titleId, { autoplay: true, startAt: chapters[index].startSeconds });
    if (!result.ok) toast.error(result.error ?? "Couldn't start this audiobook.");
  }

  return (
    <ol className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.08]">
      {chapters.map((chapter, i) => {
        const current = isCurrent && p?.chapterIndex === i;
        const end = i + 1 < chapters.length ? chapters[i + 1].startSeconds : totalSeconds;
        return (
          <li key={`${i}-${chapter.startSeconds}`}>
            <button
              type="button"
              onClick={() => open(i)}
              className={cn(
                "flex w-full items-center gap-4 px-4 py-3 text-left transition-colors outline-none hover:bg-white/[0.06] focus-visible:bg-white/[0.06]",
                current && "bg-primary/10"
              )}
            >
              <span className="w-7 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className={cn("min-w-0 flex-1 truncate text-sm", current && "font-medium text-primary")}>
                {chapter.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatClock(Math.max(0, end - chapter.startSeconds))}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Mounted on a book page opened from a playlist queue: starts the book as soon as the page
 * loads (a finished book starts over) and remembers the queue so it continues afterwards.
 * Autoplay can be blocked by the browser when the listener hasn't interacted recently; the
 * book is then simply loaded and paused.
 */
export function BookQueueAutoStart({
  titleId,
  playlistId,
  itemId,
  finished,
}: {
  titleId: string;
  playlistId: string;
  itemId: string;
  finished: boolean;
}) {
  const actions = useAudioActions();
  const started = useRef(false);
  useEffect(() => {
    if (!actions || started.current) return;
    started.current = true;
    void actions.load(titleId, { autoplay: true, startAt: finished ? 0 : undefined, queue: { playlistId, itemId } });
  }, [actions, titleId, playlistId, itemId, finished]);
  return null;
}
