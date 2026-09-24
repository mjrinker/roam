import Image from "next/image";
import Link from "next/link";

export interface ContinueWatchingItem {
  href: string;
  posterUrl: string | null;
  primaryLabel: string;
  secondaryLabel?: string | null;
  progressFraction: number;
}

export function ContinueWatchingCard({ item }: { item: ContinueWatchingItem }) {
  return (
    <Link href={item.href} className="group flex flex-col gap-2">
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-muted">
        {item.posterUrl ? (
          <Image
            src={item.posterUrl}
            alt={item.primaryLabel}
            fill
            sizes="(min-width: 1024px) 200px, 33vw"
            className="object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-sm text-muted-foreground">
            {item.primaryLabel}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, item.progressFraction * 100)}%` }}
          />
        </div>
      </div>
      <div>
        <p className="truncate text-sm font-medium">{item.primaryLabel}</p>
        {item.secondaryLabel && (
          <p className="truncate text-xs text-muted-foreground">{item.secondaryLabel}</p>
        )}
      </div>
    </Link>
  );
}
