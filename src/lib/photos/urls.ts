/**
 * The URLs a photo library's pictures are served from. Pure (no database or Box imports) so the
 * scanner, the routes and client components all build them the same way.
 *
 * The thumbnail URL carries a version that changes only when the file's CONTENT changes (its size or
 * modified time in Box), never on a rescan, so a browser can keep a thumbnail for a day and still
 * see a replaced photo's new one. Every route behind these URLs checks access before answering.
 */
export const photoThumbUrl = (titleId: string, version: string) => `/api/photos/${titleId}/thumb?v=${version}`;
export const photoPreviewUrl = (titleId: string) => `/api/photos/${titleId}/preview`;
export const photoOriginalUrl = (titleId: string) => `/api/photos/${titleId}/original`;

/** A short stable token for "this content": same size and modified second give the same token. */
export function thumbVersion(file: { sizeBytes?: number; modifiedAt?: Date; createdAt?: Date }): string {
  const when = (file.modifiedAt ?? file.createdAt)?.getTime();
  const seconds = when === undefined ? 0 : Math.floor(when / 1000);
  return `${(file.sizeBytes ?? 0).toString(36)}-${seconds.toString(36)}`;
}

/** The ordering time of an item: Box's content-created date, else its modified date, else the moment it was scanned. */
export function boxTakenAt(file: { createdAt?: Date; modifiedAt?: Date }, scannedAt: Date): { at: Date; source: "box" | "scan" } {
  const box = file.createdAt ?? file.modifiedAt;
  if (box) return { at: new Date(Math.floor(box.getTime() / 1000) * 1000), source: "box" };
  return { at: new Date(Math.floor(scannedAt.getTime() / 1000) * 1000), source: "scan" };
}
