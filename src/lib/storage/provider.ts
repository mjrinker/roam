/**
 * Storage-provider-agnostic interface. Box is the only implementation today,
 * but the scanner and play-manifest code depend only on this shape so a
 * second provider (Google Drive, etc.) can be added later without touching
 * them.
 */

export interface StorageEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  sizeBytes?: number;
}

export interface StreamingUrl {
  /** A URL the browser can fetch/range-request directly — no further auth. */
  url: string;
  /** When this URL stops working; the caller should re-mint after this. */
  expiresAt: Date;
}

/** A strict listing couldn't return every entry (too many, or the provider stopped paging early). */
export class ListingTruncatedError extends Error {
  constructor(folderId: string) {
    super(`Folder ${folderId} has more entries than can be listed.`);
    this.name = "ListingTruncatedError";
  }
}

export interface StorageProvider {
  /**
   * Lists the direct children of a folder (files and subfolders), fully paginated. By default a
   * runaway folder is cut off silently; with `strict` it throws ListingTruncatedError instead, for
   * callers that act on absence (a silently shortened list must never look like a complete one).
   */
  listFolder(folderId: string, opts?: { strict?: boolean }): Promise<StorageEntry[]>;

  /** Fetches a single folder's current metadata (e.g. to pick up a rename). Null if it no longer exists. */
  getFolder(folderId: string): Promise<StorageEntry | null>;

  /** Mints a short-lived direct-download URL for a single file. */
  getStreamingUrl(fileId: string): Promise<StreamingUrl>;

  /** Fetches an inclusive byte range of a file's raw bytes (for format probing). */
  fetchByteRange(
    fileId: string,
    startByte: number,
    endByte: number
  ): Promise<ArrayBuffer>;
}
