/** Playing a downloaded item from the files on this device. Browser only. */
import type { AudiobookManifest, PlayManifest } from "@/lib/player/types";
import { pendingProgressFor } from "./sync";
import { findCompleteDownload, initDownloads } from "./manager";
import { openSavedFile } from "./storage";
import type { DownloadRecord } from "./types";

/** Local files never expire; this just keeps "expires at" far off yet inside what a timer can count. */
const LOCAL_EXPIRY_MS = 7 * 24 * 3600_000;

export interface LocalFiles {
  /** One address per saved file, in order, that a media element can play. */
  urls: string[];
  /** Lets go of the addresses (call when the player is done with them). */
  release: () => void;
}

/** Opens a download's files for playing; null when any of them is missing (cleared by the browser, say). */
export async function openLocalFiles(record: DownloadRecord): Promise<LocalFiles | null> {
  const urls: string[] = [];
  for (const f of record.files) {
    const file = await openSavedFile(f.name);
    if (!file || (f.expected !== null && file.size < f.expected)) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    }
    urls.push(URL.createObjectURL(file));
  }
  return { urls, release: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

/** The completed video download to play for this item, if there is one (the named version preferred). */
export async function localVideoFor(ownerKind: PlayManifest["ownerKind"], ownerId: string, version?: string): Promise<DownloadRecord | null> {
  await initDownloads();
  return findCompleteDownload("watch", ownerKind, ownerId, version);
}

/** The completed audio download (a song or audiobook) to play for this item, if there is one. */
export async function localAudioFor(titleId: string): Promise<DownloadRecord | null> {
  await initDownloads();
  return findCompleteDownload("listen", "title", titleId);
}

/** A downloaded song/audiobook as the audio player's manifest, for when the server can't be asked. Resumes from progress made offline. */
export async function offlineAudioManifest(record: DownloadRecord, files: LocalFiles): Promise<AudiobookManifest | null> {
  if (!record.book) return null;
  const pending = await pendingProgressFor(record.ownerKind, record.ownerId);
  const expiresAt = new Date(Date.now() + LOCAL_EXPIRY_MS).toISOString();
  return {
    ...record.book,
    resumeSeconds: pending && !pending.finished ? pending.positionSeconds : 0,
    urls: files.urls.map((url, index) => ({ index, url, expiresAt })),
  };
}

/**
 * The play manifest for a downloaded video when there is no connection to ask the server: the saved timeline with the local files as its
 * addresses, resuming from progress made offline.
 */
export async function offlineVideoManifest(record: DownloadRecord, files: LocalFiles): Promise<PlayManifest | null> {
  if (!record.timeline) return null;
  const pending = await pendingProgressFor(record.ownerKind, record.ownerId);
  return {
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    durationSeconds: record.timeline.durationSeconds,
    segments: record.timeline.segments.map((s, i) => ({ ...s, url: files.urls[i] })),
    resumeSeconds: pending && !pending.finished ? pending.positionSeconds : 0,
    expiresAt: new Date(Date.now() + LOCAL_EXPIRY_MS).toISOString(),
    version: record.version,
    versions: [{ label: record.version, name: record.versionName, height: null }],
    libraryId: undefined,
    defaultRate: record.timeline.defaultRate ?? null,
  };
}

/**
 * Puts the saved files in place of a manifest's network addresses when this item's version is downloaded. The manifest must be for the
 * same version (same parts), else it is left alone. Returns the files to release later, or null when nothing was replaced.
 */
export async function applyLocalFiles(manifest: PlayManifest): Promise<LocalFiles | null> {
  const record = await localVideoFor(manifest.ownerKind, manifest.ownerId, manifest.version);
  if (!record || record.version !== (manifest.version ?? "") || record.files.length !== manifest.segments.length) return null;
  const files = await openLocalFiles(record);
  if (!files) return null;
  manifest.segments = manifest.segments.map((s, i) => ({ ...s, url: files.urls[i] }));
  manifest.expiresAt = new Date(Date.now() + LOCAL_EXPIRY_MS).toISOString();
  return files;
}
