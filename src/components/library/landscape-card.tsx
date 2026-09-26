import Image from "next/image";
import Link from "next/link";
import { Film, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LandscapeCardData {
  href: string;
  imageUrl: string | null;
  primaryLabel: string;
  secondaryLabel?: string | null;
  /** 0..1 */
  progressFraction: number;
  /** e.g. "34 min left" */
  remainingLabel?: string | null;
}

/** A 16:9 "pick up where you left off" card. */
export function LandscapeCard({
  item,
  className,
}: {
  item: LandscapeCardData;
  className?: string;
}) {
  return (
    <Link href={item.href} className={cn("group/card block min-w-0 outline-none", className)}>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-muted ring-1 ring-white/[0.08] transition duration-300 ease-out group-hover/card:-translate-y-1 group-hover/card:shadow-[0_20px_40px_-14px_rgba(0,0,0,0.9)] group-hover/card:ring-white/25 group-focus-visible/card:ring-2 group-focus-visible/card:ring-primary">
        {item.imageUrl ? (
          <Image
            src={item.imageUrl}
            alt=""
            fill
            sizes="(min-width: 1024px) 320px, 70vw"
            className="object-cover transition-transform duration-500 ease-out group-hover/card:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary to-muted">
            <Film className="size-8 text-muted-foreground/50" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
            <Play className="ml-0.5 size-5" fill="currentColor" />
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, item.progressFraction * 100)}%` }}
          />
        </div>
      </div>
      <div className="mt-2.5 px-0.5">
        <p className="truncate text-sm font-medium group-hover/card:text-primary">
          {item.primaryLabel}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {[item.secondaryLabel, item.remainingLabel].filter(Boolean).join(" · ")}
        </p>
      </div>
    </Link>
  );
}
