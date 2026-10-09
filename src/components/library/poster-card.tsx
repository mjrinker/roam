import { Artwork as Image } from "@/components/ui/artwork";
import Link from "next/link";
import { BookOpen, Check, Film, Headphones, Play, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TitleKind } from "@/lib/db/schema";
import { doneKindOf, doneWords } from "@/lib/watch/words";

export interface PosterCardData {
  id: string;
  kind: TitleKind;
  name: string;
  year: number | null;
  /** Overrides the "year · kind" line (e.g. an audiobook's author). */
  subtitle?: string | null;
  posterUrl: string | null;
  /** 0..1 — shows a resume bar along the bottom edge. */
  progressFraction?: number | null;
  watched?: boolean;
  /** Files exist but haven't finished being probed yet, so it can't play. */
  processing?: boolean;
}

export function PosterFallback({ name, kind }: { name: string; kind: TitleKind }) {
  const Icon = kind === "show" ? Tv : kind === "audiobook" ? Headphones : kind === "ebook" ? BookOpen : Film;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary via-muted to-background p-4 text-center">
      <Icon className="size-7 text-muted-foreground/60" />
      <span className="line-clamp-4 text-sm font-medium text-muted-foreground">{name}</span>
    </div>
  );
}

export function PosterCard({
  title,
  serverId,
  className,
}: {
  title: PosterCardData;
  serverId: string;
  className?: string;
}) {
  const href =
    title.kind === "show"
      ? `/s/${serverId}/show/${title.id}`
      : title.kind === "audiobook"
        ? `/s/${serverId}/book/${title.id}`
        : title.kind === "ebook"
          ? `/s/${serverId}/ebook/${title.id}`
          : `/s/${serverId}/title/${title.id}`;
  const progress =
    typeof title.progressFraction === "number" && title.progressFraction > 0
      ? Math.min(1, title.progressFraction)
      : 0;

  return (
    <Link href={href} className={cn("group/card block min-w-0 outline-none", className)}>
      <div className={cn("relative overflow-hidden rounded-xl bg-muted ring-1 ring-white/[0.08] transition duration-300 ease-out group-hover/card:-translate-y-1 group-hover/card:shadow-[0_20px_40px_-14px_rgba(0,0,0,0.9)] group-hover/card:ring-white/25 group-focus-visible/card:ring-2 group-focus-visible/card:ring-primary", title.kind === "audiobook" ? "aspect-square" : "aspect-[2/3]")}>
        {title.posterUrl ? (
          <Image
            src={title.posterUrl}
            alt={title.name}
            fill
            sizes="(min-width: 1280px) 190px, (min-width: 640px) 170px, 40vw"
            className="object-cover transition-transform duration-500 ease-out group-hover/card:scale-[1.04]"
          />
        ) : (
          <PosterFallback name={title.name} kind={title.kind} />
        )}

        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/70 via-black/20 to-black/10 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
          <span className="flex size-12 scale-90 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-200 group-hover/card:scale-100">
            <Play className="ml-0.5 size-5" fill="currentColor" />
          </span>
        </div>

        {title.watched && (
          <span
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md"
            title={doneWords(doneKindOf(title.kind)).done}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        )}
        {title.processing && (
          <span className="absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary uppercase backdrop-blur">
            Processing
          </span>
        )}
        {progress > 0 && !title.watched && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>

      <div className="mt-2.5 px-0.5">
        <p className="truncate text-sm font-medium leading-snug group-hover/card:text-primary">
          {title.name}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {title.subtitle ||
            [title.year, title.kind === "show" ? "TV Show" : title.kind === "audiobook" ? "Audiobook" : null]
              .filter(Boolean)
              .join(" · ") ||
            " "}
        </p>
      </div>
    </Link>
  );
}
