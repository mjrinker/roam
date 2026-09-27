"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Headphones, Loader2, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, PLAYBACK_RATES } from "@/lib/player/timeline";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  SKIP_BACK_SECONDS,
  SKIP_FORWARD_SECONDS,
  useAudioPlayer,
  type SleepRequest,
} from "@/components/audio/audio-player-provider";

const SLEEP_OPTIONS: { label: string; request: SleepRequest }[] = [
  { label: "15 min", request: { minutes: 15 } },
  { label: "30 min", request: { minutes: 30 } },
  { label: "45 min", request: { minutes: 45 } },
  { label: "60 min", request: { minutes: 60 } },
  { label: "End of chapter", request: "chapter" },
];

function firstValue(v: number | readonly number[]): number {
  return Array.isArray(v) ? v[0] : (v as number);
}

function Chip({
  active,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary text-primary-foreground ring-primary"
          : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10 hover:text-foreground"
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Full-size player: big cover and controls, plus everything the compact bar hides on small screens. */
export function NowPlayingSheet({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const p = useAudioPlayer();
  const [drag, setDrag] = useState<number | null>(null);

  const book = p?.book;
  if (!p || !book) return null;

  const playing = p.status === "playing";
  const busy = p.status === "loading" || (p.buffering && p.status !== "paused");
  const shown = Math.min(drag ?? p.position, book.durationSeconds);
  const chapter = p.chapterIndex >= 0 ? book.chapters[p.chapterIndex] : null;
  const sleepActive = p.sleep !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] gap-5 overflow-y-auto sm:max-w-md">
        <DialogTitle className="sr-only">Now playing</DialogTitle>
        <DialogDescription className="sr-only">
          Full audiobook player controls for {book.name}.
        </DialogDescription>

        <div className="relative mx-auto aspect-square w-full max-w-64 overflow-hidden rounded-2xl bg-muted shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
          {book.coverUrl ? (
            <Image src={book.coverUrl} alt={book.name} fill sizes="256px" className="object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Headphones className="size-12" />
            </div>
          )}
        </div>

        <div className="text-center">
          <Link
            href={`/s/${serverId}/book/${book.titleId}`}
            onClick={() => onOpenChange(false)}
            className="text-lg leading-snug font-semibold text-balance hover:text-primary"
          >
            {book.name}
          </Link>
          {book.authors.length > 0 && (
            <p className="mt-0.5 text-sm text-muted-foreground">{book.authors.join(", ")}</p>
          )}
          {chapter && <p className="mt-1 truncate text-xs text-primary">{chapter.title}</p>}
          {p.status === "error" && <p className="mt-1 text-xs text-destructive">{p.error}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Slider
            aria-label="Seek"
            min={0}
            max={Math.max(1, Math.floor(book.durationSeconds))}
            step={1}
            value={[shown]}
            onValueChange={(v) => setDrag(firstValue(v))}
            onValueCommitted={(v) => {
              p.seek(firstValue(v));
              setDrag(null);
            }}
          />
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{formatClock(shown)}</span>
            <span>-{formatClock(book.durationSeconds - shown)}</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-6">
          <button
            type="button"
            aria-label={`Back ${SKIP_BACK_SECONDS} seconds`}
            onClick={() => p.skip(-SKIP_BACK_SECONDS)}
            className="flex size-12 items-center justify-center rounded-full text-foreground/80 transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="size-6" />
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={p.toggle}
            className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? (
              <Loader2 className="size-7 animate-spin" />
            ) : playing ? (
              <Pause className="size-7" fill="currentColor" />
            ) : (
              <Play className="size-7" fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`}
            onClick={() => p.skip(SKIP_FORWARD_SECONDS)}
            className="flex size-12 items-center justify-center rounded-full text-foreground/80 transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw className="size-6" />
          </button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Speed</h3>
          <div className="flex flex-wrap gap-1.5">
            {PLAYBACK_RATES.map((r) => (
              <Chip key={r} active={p.rate === r} onClick={() => p.setRate(r)}>
                {r}×
              </Chip>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Sleep timer{p.sleep?.kind === "minutes" && p.sleepMinutesLeft ? ` · ${p.sleepMinutesLeft} min left` : ""}
            {p.sleep?.kind === "chapter" ? " · end of chapter" : ""}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!sleepActive} onClick={() => p.setSleep(null)}>
              Off
            </Chip>
            {SLEEP_OPTIONS.map((o) => (
              <Chip key={o.label} onClick={() => p.setSleep(o.request)}>
                {o.label}
              </Chip>
            ))}
          </div>
        </section>

        {book.chapters.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Chapters</h3>
            <ol className="max-h-56 divide-y divide-white/[0.06] overflow-y-auto rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08]">
              {book.chapters.map((c, i) => (
                <li key={`${i}-${c.startSeconds}`}>
                  <button
                    type="button"
                    onClick={() => {
                      p.jumpToChapter(i);
                      p.play();
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-white/[0.06] focus-visible:bg-white/[0.06]",
                      i === p.chapterIndex && "bg-primary/10 text-primary"
                    )}
                  >
                    <span className="truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatClock(c.startSeconds)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
