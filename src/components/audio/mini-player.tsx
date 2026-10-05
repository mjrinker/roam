"use client";

import { useState } from "react";
import { Artwork as Image } from "@/components/ui/artwork";
import Link from "next/link";
import { ChevronUp, Headphones, List, Loader2, Moon, Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, PLAYBACK_RATES } from "@/lib/player/timeline";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NowPlayingSheet } from "@/components/audio/now-playing-sheet";
import {
  SKIP_BACK_SECONDS,
  SKIP_FORWARD_SECONDS,
  useAudioPlayer,
  type SleepTimer,
} from "@/components/audio/audio-player-provider";

const SLEEP_MINUTES = [15, 30, 45, 60] as const;

function firstValue(v: number | readonly number[]): number {
  return Array.isArray(v) ? v[0] : (v as number);
}

function sleepLabel(sleep: SleepTimer, minutesLeft: number | null): string | null {
  if (!sleep) return null;
  return sleep.kind === "chapter" || minutesLeft === null ? "End of chapter" : `${minutesLeft} min`;
}

function IconButton({
  label,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Persistent audiobook player bar: stays mounted while you browse. Renders nothing until a book is loaded. */
export function MiniPlayer({ serverId }: { serverId: string }) {
  const p = useAudioPlayer();
  const [drag, setDrag] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (!p?.book) return null;
  const { book } = p;

  const playing = p.status === "playing";
  const busy = p.status === "loading" || (p.buffering && p.status !== "paused");
  const shown = drag ?? p.position;
  const chapter = p.chapterIndex >= 0 ? book.chapters[p.chapterIndex] : null;
  const subtitle = [book.authors.join(", "), chapter?.title].filter(Boolean).join(" · ");
  const sleep = sleepLabel(p.sleep, p.sleepMinutesLeft);

  return (
    <div className="sticky bottom-0 z-40 border-t border-white/10 bg-background/90 backdrop-blur-xl">
      <Slider
        aria-label="Seek"
        min={0}
        max={Math.max(1, Math.floor(book.durationSeconds))}
        step={1}
        value={[Math.min(shown, book.durationSeconds)]}
        onValueChange={(v) => setDrag(firstValue(v))}
        onValueCommitted={(v) => {
          p.seek(firstValue(v));
          setDrag(null);
        }}
        className="-mt-1.5 h-3 px-0 [&_[data-slot=slider-thumb]]:opacity-0 hover:[&_[data-slot=slider-thumb]]:opacity-100 [&_[data-slot=slider-track]]:h-1"
      />

      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-6">
        <Link
          href={`/s/${serverId}/book/${book.titleId}`}
          className="group flex min-w-0 flex-1 items-center gap-3 outline-none"
        >
          <span className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-white/10">
            {book.coverUrl ? (
              <Image src={book.coverUrl} alt="" fill sizes="48px" className="object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-muted-foreground">
                <Headphones className="size-5" />
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium group-hover:text-primary group-focus-visible:text-primary">
              {book.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {p.status === "error" ? (p.error ?? "Playback error") : subtitle}
            </span>
          </span>
        </Link>

        <span className="hidden text-xs text-muted-foreground tabular-nums lg:block">
          {formatClock(shown)} / {formatClock(book.durationSeconds)}
        </span>

        <div className="flex items-center gap-1">
          <IconButton label={`Back ${SKIP_BACK_SECONDS} seconds`} onClick={() => p.skip(-SKIP_BACK_SECONDS)}>
            <RotateCcw className="size-5" />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={p.toggle}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? (
              <Loader2 className="size-5 animate-spin" />
            ) : playing ? (
              <Pause className="size-5" fill="currentColor" />
            ) : (
              <Play className="size-5" fill="currentColor" />
            )}
          </button>
          <IconButton label={`Forward ${SKIP_FORWARD_SECONDS} seconds`} onClick={() => p.skip(SKIP_FORWARD_SECONDS)}>
            <RotateCw className="size-5" />
          </IconButton>
        </div>

        <div className="hidden items-center gap-0.5 sm:flex">
          {book.chapters.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Chapters"
                title="Chapters"
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <List className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="max-h-80 w-72">
                <DropdownMenuLabel>Chapters</DropdownMenuLabel>
                {book.chapters.map((c, i) => (
                  <DropdownMenuItem
                    key={`${i}-${c.startSeconds}`}
                    onClick={() => {
                      p.jumpToChapter(i);
                      p.play();
                    }}
                    className={cn("justify-between gap-3", i === p.chapterIndex && "text-primary")}
                  >
                    <span className="truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatClock(c.startSeconds)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Playback speed"
              title="Playback speed"
              className="flex h-9 min-w-11 items-center justify-center rounded-full px-2 text-sm font-medium text-muted-foreground tabular-nums outline-none hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {p.rate}×
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-36">
              <DropdownMenuLabel>Speed</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={String(p.rate)} onValueChange={(v) => p.setRate(Number(v))}>
                {PLAYBACK_RATES.map((r) => (
                  <DropdownMenuRadioItem key={r} value={String(r)}>
                    {r}×
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Sleep timer"
              title={sleep ? `Sleep timer: ${sleep}` : "Sleep timer"}
              className={cn(
                "flex size-9 items-center justify-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring",
                sleep ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Moon className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-44">
              <DropdownMenuLabel>{sleep ? `Sleep in ${sleep}` : "Sleep timer"}</DropdownMenuLabel>
              {SLEEP_MINUTES.map((minutes) => (
                <DropdownMenuItem key={minutes} onClick={() => p.setSleep({ minutes })}>
                  {minutes} minutes
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => p.setSleep("chapter")}>End of chapter</DropdownMenuItem>
              {sleep && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => p.setSleep(null)}>Turn off</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <IconButton label="Expand player" onClick={() => setExpanded(true)}>
          <ChevronUp className="size-5" />
        </IconButton>
        <IconButton label="Close player" onClick={p.close} className="hidden sm:flex">
          <X className="size-5" />
        </IconButton>
      </div>

      <NowPlayingSheet serverId={serverId} open={expanded} onOpenChange={setExpanded} />
    </div>
  );
}
