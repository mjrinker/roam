/**
 * Casting the picture to a Chromecast (Google's Cast sender, loaded only when the player is opened in Chrome or Edge) or an AirPlay screen (Safari).
 * The pure parts, naming what to send, are here and tested; the rest talks to the browser's casting APIs and can only be tried on real devices.
 */
import type { PlayManifest } from "@/lib/player/types";

export interface CastItem {
  url: string;
  contentType: string;
  /** Seconds from the start of the whole video to the start of this file. */
  startSeconds: number;
  durationSeconds: number;
}

const CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" };

/** What to send a Chromecast: one item per file of the video (they play one after another), in order. */
export function castItems(manifest: Pick<PlayManifest, "segments">): CastItem[] {
  return manifest.segments.map((s) => ({ url: s.url, contentType: CONTENT_TYPES[(s.container ?? "mp4").toLowerCase()] ?? "video/mp4", startSeconds: s.startSeconds, durationSeconds: s.durationSeconds }));
}

/** Which item of the queue, and how far into it, a place in the whole video is. */
export function castPosition(items: CastItem[], globalSeconds: number): { index: number; seconds: number } {
  let index = 0;
  for (let i = 0; i < items.length; i++) if (globalSeconds >= items[i].startSeconds) index = i;
  return { index, seconds: Math.max(0, globalSeconds - items[index].startSeconds) };
}

/** The place in the whole video for an item of the queue and a time in it (the other way round). */
export function castGlobal(items: CastItem[], index: number, seconds: number): number {
  return (items[index]?.startSeconds ?? 0) + seconds;
}

/** Whether AirPlay can take this video (Safari's own picker plays the one file the picture is showing, so a video in parts can't use it). */
export function airPlayUsable(manifest: Pick<PlayManifest, "segments"> | null, videoEl: { webkitShowPlaybackTargetPicker?: unknown } | null): boolean {
  return !!manifest && manifest.segments.length === 1 && typeof videoEl?.webkitShowPlaybackTargetPicker === "function";
}
