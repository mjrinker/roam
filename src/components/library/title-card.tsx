import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export interface TitleCardData {
  id: string;
  kind: "movie" | "show";
  name: string;
  year: number | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
  progressFraction?: number | null;
}

export function TitleCard({ title, serverId }: { title: TitleCardData; serverId: string }) {
  const href =
    title.kind === "show"
      ? `/s/${serverId}/show/${title.id}`
      : `/s/${serverId}/title/${title.id}`;
  return (
    <Link href={href} className="group flex flex-col gap-2">
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-muted">
        {title.posterUrl ? (
          <Image
            src={title.posterUrl}
            alt={title.name}
            fill
            sizes="(min-width: 1024px) 200px, 33vw"
            className="object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-sm text-muted-foreground">
            {title.name}
          </div>
        )}
        {typeof title.progressFraction === "number" && title.progressFraction > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, title.progressFraction * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div>
        <p className="truncate text-sm font-medium">{title.name}</p>
        {title.year && (
          <Badge variant="secondary" className="mt-1 text-xs">
            {title.year}
          </Badge>
        )}
      </div>
    </Link>
  );
}
