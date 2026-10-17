"use client";

import Image, { type ImageProps } from "next/image";
import { imageQuality } from "@/lib/player/data-saver";
import { useDataSaver } from "@/components/ui/data-saver-context";

/**
 * `next/image` for a title's poster or backdrop. Images Roam serves itself (`/api/...`, e.g. a video's
 * embedded cover) sit behind the viewer's login, so they must NOT go through Next's image optimizer:
 * it caches by URL alone, which could hand one viewer's cached copy to another who was never allowed
 * to see it. Those load straight from the (private, per-session) route; everything else (TMDB, Audible)
 * is optimized as before. Use this, never `next/image`, wherever a title's artwork is drawn.
 * With the profile's data saver on, optimized pictures are fetched at lower quality.
 */
export function Artwork({ alt, ...props }: ImageProps) {
  const own = typeof props.src === "string" && props.src.startsWith("/api/");
  const saver = useDataSaver();
  return <Image {...props} alt={alt} unoptimized={own || props.unoptimized} quality={props.quality ?? imageQuality(saver)} />;
}
