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
  /** When the file's content was created / last changed, as Box reports them (files only; absent when missing or implausible). */
  createdAt?: Date;
  modifiedAt?: Date;
}

/** A generated preview picture: always a JPEG, never larger than the provider's cap. */
export interface PreviewImage {
  contentType: "image/jpeg";
  bytes: Uint8Array;
  /** The longest edge it was asked at (2048, 1024). */
  size: number;
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
  /** The id of the top folder of this storage (what a folder picker starts from). Absent: "0", Box's. */
  rootFolderId?(): string;

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

  /** Like getStreamingUrl, but never reused from a cache: for a link handed to a person, who may follow it much later. */
  getFreshDownloadUrl?(fileId: string): Promise<StreamingUrl>;

  /**
   * A small preview image the storage service generated for a file (e.g. a video frame), or null
   * when none is available (not generated yet, unsupported, or the provider has no such thing).
   */
  fetchThumbnail?(fileId: string): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | null>;

  /**
   * A large preview picture (about 2048px; smaller if that isn't available) of an image or HEIC photo,
   * or null when none could be made within `budgetMs`. Never the original file.
   */
  fetchPreview?(fileId: string, opts?: { budgetMs?: number }): Promise<PreviewImage | null>;

  /**
   * A URL a browser can play directly: the storage service's own browser-friendly (H.264) version of a
   * video, which it makes itself, or null when that isn't available in time (the caller plays the
   * original). The URL carries a token that can read this one file and nothing else.
   */
  getBrowserVideoUrl?(fileId: string, opts?: { budgetMs?: number }): Promise<StreamingUrl | null>;

  /**
   * Whether a file still exists and isn't in the trash. False only for a definite "gone"; anything
   * else the provider can't tell throws. Optional: without it nothing is ever removed for being missing.
   */
  fileExists?(fileId: string): Promise<boolean>;

  /**
   * Writing, for providers that can. These are only ever called through ServerStorage, which first checks that the connection allows
   * editing (the admin turned it on and the sign-in was given the provider's write permission). Roam only ever replaces a file's contents,
   * saves a small file beside others, and renames: it never deletes. The provider's own version history keeps what a replaced file was.
   */
  /** The whole of a file, for Roam to change and send back; throws when it is bigger than `maxBytes`. */
  readFile?(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Replaces a file's contents with `bytes`, keeping the file (its id, its place and its name). */
  replaceFile?(fileId: string, bytes: Uint8Array): Promise<void>;
  /** Saves a file in a folder, replacing one of that name if there is one. Returns the file's id. */
  createFile?(parentFolderId: string, name: string, bytes: Uint8Array): Promise<{ id: string }>;
  /** Renames a file or folder in place. */
  renameEntry?(kind: "file" | "folder", id: string, name: string): Promise<void>;
  /** The folder a file is in. */
  parentFolderId?(fileId: string): Promise<string>;

  /** Fetches an inclusive byte range of a file's raw bytes (for format probing). */
  fetchByteRange(
    fileId: string,
    startByte: number,
    endByte: number
  ): Promise<ArrayBuffer>;
}
