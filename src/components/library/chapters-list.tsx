import Link from "next/link";
import { Play } from "lucide-react";
import type { Chapter } from "@/lib/chapters/chapters";
import { formatClock } from "@/lib/player/timeline";
import { cn } from "@/lib/utils";

/**
 * A movie's or episode's chapters, each a link that opens the player there. A closed disclosure ("Chapters (24)") so a long list
 * stays out of the way; `compact` is the small form used under an episode.
 */
export function ChaptersList({
  serverId,
  ownerKind,
  ownerId,
  chapters,
  compact = false,
}: {
  serverId: string;
  ownerKind: "title" | "episode";
  ownerId: string;
  chapters: Chapter[];
  compact?: boolean;
}) {
  if (chapters.length === 0) return null;
  const list = (
    <ol className={cn("grid gap-1.5", compact ? "mt-2 sm:grid-cols-2" : "mt-4 sm:grid-cols-2 lg:grid-cols-3")}>
      {chapters.map((c, i) => (
        <li key={c.startSeconds}>
          <Link
            href={`/s/${serverId}/watch/${ownerKind}/${ownerId}?t=${Math.floor(c.startSeconds)}`}
            className="group/chapter flex min-w-0 items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Play className="size-3" fill="currentColor" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}.</span>
              {c.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatClock(c.startSeconds)}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
  return (
    <details className={cn("group/chapters", compact ? "px-2.5 pb-2" : "mx-auto w-full max-w-5xl px-4 pt-8 sm:px-8")}>
      <summary
        className={cn(
          "w-fit cursor-pointer list-none rounded-md select-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden",
          compact ? "text-xs font-medium text-muted-foreground hover:text-foreground" : "text-lg font-semibold tracking-tight"
        )}
      >
        Chapters <span className="font-normal text-muted-foreground">({chapters.length})</span>
        <span className="ml-1.5 text-muted-foreground transition-transform group-open/chapters:rotate-90 inline-block" aria-hidden="true">
          ›
        </span>
      </summary>
      {list}
    </details>
  );
}
