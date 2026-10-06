/**
 * What the viewer needs to show one item, built from a timeline item (or a page's own details), so opening
 * or stepping to an item needs no further request. Pure; client and server both use it.
 */
import { formatFileSize, formatRuntime } from "@/lib/format";
import { photoOriginalUrl, photoPreviewUrl } from "@/lib/photos/urls";

export interface ViewerItem {
  id: string;
  kind: "photo" | "movie";
  name: string;
  /** The small cached picture shown at once (and beside the current item while swiping). */
  thumbUrl: string | null;
  previewUrl: string;
  originalUrl: string;
  /** Zooming far in may swap to the full-size file: only for formats browsers show (never HEIC). */
  zoomOriginal: boolean;
  details: [string, string][];
  favorite: boolean;
}

export interface ViewerSource {
  id: string;
  kind: "photo" | "movie";
  name: string;
  takenAt: string | Date | null;
  width: number | null;
  height: number | null;
  posterUrl: string | null;
  runtimeSeconds: number | null;
  favorite: boolean;
  filename: string | null;
  sizeBytes: number | null;
  container: string | null;
  folderPath: string;
}

const takenFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });

export function viewerItem(s: ViewerSource): ViewerItem {
  const taken = s.takenAt ? new Date(s.takenAt) : null;
  const rows: [string, string | null][] = [
    ["Taken", taken && !Number.isNaN(taken.getTime()) ? takenFormat.format(taken) : null],
    ["Size", s.width && s.height ? `${s.width} × ${s.height}` : null],
    ["Length", s.kind === "movie" ? formatRuntime(s.runtimeSeconds) : null],
    ["File", s.filename],
    ["File size", formatFileSize(s.sizeBytes)],
    ["Album", s.folderPath || null],
  ];
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    thumbUrl: s.posterUrl,
    previewUrl: photoPreviewUrl(s.id),
    originalUrl: photoOriginalUrl(s.id),
    zoomOriginal: s.kind === "photo" && ["jpg", "jpeg", "png", "webp"].includes((s.container ?? "").toLowerCase()),
    details: rows.filter((r): r is [string, string] => r[1] !== null),
    favorite: s.favorite,
  };
}
