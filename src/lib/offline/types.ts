import type { AudiobookManifest, PlayManifest, PlayOwnerKind, PlaySegment } from "@/lib/player/types";

export type DownloadKind = "watch" | "listen";

export type DownloadStatus = "downloading" | "paused" | "error" | "complete";

/** One saved file: a part of a film, or of a book. `name` is its file name in the browser's private storage. */
export interface StoredFile {
  name: string;
  /** Bytes saved so far. */
  bytes: number;
  /** The file's full size once known. */
  expected: number | null;
  done: boolean;
}

/** What is kept in IndexedDB for each download (the media itself is in the browser's file storage). */
export interface DownloadRecord {
  /** `${kind}:${ownerKind}:${ownerId}:${version}` - one per item and version. */
  id: string;
  kind: DownloadKind;
  ownerKind: PlayOwnerKind;
  ownerId: string;
  serverId: string;
  /** The profile (who's watching) that downloaded it; only that profile sees and plays it. */
  viewerId: string;
  title: string;
  subtitle: string | null;
  poster: Blob | null;
  /** The resolution version ("" for audio and for files with no label) and the name the picker showed. */
  version: string;
  versionName: string;
  totalBytes: number | null;
  files: StoredFile[];
  /** Video: the timeline without addresses (they are the local files). */
  timeline: { durationSeconds: number; segments: Omit<PlaySegment, "url">[]; libraryId?: string; defaultRate?: number | null } | null;
  /** Audio: the book/song details without addresses. */
  book: Omit<AudiobookManifest, "urls" | "resumeSeconds"> | null;
  status: DownloadStatus;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** Progress made while offline, waiting to be sent to the server (the same shape as a watch-state update). */
export interface PendingProgress {
  key: string;
  /** The profile the progress belongs to. */
  viewerId: string;
  ownerKind: PlayOwnerKind;
  ownerId: string;
  positionSeconds: number;
  durationSeconds: number;
  finished: boolean;
  at: number;
}

export type LocalPlayManifest = PlayManifest;

export const downloadId = (kind: DownloadKind, ownerKind: PlayOwnerKind, ownerId: string, version: string) => `${kind}:${ownerKind}:${ownerId}:${version}`;
