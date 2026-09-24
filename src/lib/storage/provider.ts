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

export interface StorageProvider {
  /** Lists the direct children of a folder (files and subfolders), fully paginated. */
  listFolder(folderId: string): Promise<StorageEntry[]>;

  /** Mints a short-lived direct-download URL for a single file. */
  getStreamingUrl(fileId: string): Promise<StreamingUrl>;

  /** Fetches an inclusive byte range of a file's raw bytes (for format probing). */
  fetchByteRange(
    fileId: string,
    startByte: number,
    endByte: number
  ): Promise<ArrayBuffer>;
}
