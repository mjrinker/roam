"use client";

import Link from "next/link";
import { useState } from "react";
import { Image as ImageIcon, Play } from "lucide-react";
import { Artwork } from "@/components/ui/artwork";
import { cn } from "@/lib/utils";

export interface PhotoTileData {
  id: string;
  kind: "photo" | "movie";
  name: string;
  posterUrl: string | null;
  runtimeSeconds: number | null;
}

function duration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** Where a tile leads: a picture opens the viewer (remembering where you came from), a video plays. */
export function photoHref(serverId: string, item: Pick<PhotoTileData, "id" | "kind">, from: string): string {
  return item.kind === "photo" ? `/s/${serverId}/photo/${item.id}?${from}` : `/s/${serverId}/watch/title/${item.id}`;
}

/** One square in a photo grid. A thumbnail that isn't ready (Box makes them on demand) or fails shows a quiet placeholder instead of a broken image. */
export function PhotoTile({ serverId, item, from, priority = false }: { serverId: string; item: PhotoTileData; from: string; priority?: boolean }) {
  const [failed, setFailed] = useState(false);
  const length = item.kind === "movie" ? duration(item.runtimeSeconds) : null;
  return (
    <Link
      href={photoHref(serverId, item, from)}
      aria-label={item.kind === "movie" ? `Play video ${item.name}` : `Open photo ${item.name}`}
      className="group/tile relative block aspect-square overflow-hidden rounded-md bg-muted outline-none ring-1 ring-white/[0.06] focus-visible:ring-2 focus-visible:ring-primary"
    >
      {item.posterUrl && !failed ? (
        <Artwork
          src={item.posterUrl}
          alt=""
          fill
          sizes="(min-width: 1280px) 12vw, (min-width: 768px) 18vw, 33vw"
          loading={priority ? "eager" : "lazy"}
          onError={() => setFailed(true)}
          className="object-cover transition duration-200 group-hover/tile:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-gradient-to-br from-secondary to-muted">
          <ImageIcon className="size-6 text-muted-foreground/50" aria-hidden />
        </div>
      )}
      {item.kind === "movie" && (
        <span className={cn("absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white")}>
          <Play className="size-3 fill-current" aria-hidden />
          {length}
        </span>
      )}
    </Link>
  );
}
