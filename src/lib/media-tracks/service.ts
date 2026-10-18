/**
 * Serves the audio and subtitle tracks inside a video file to the player (see mp4-tracks.ts): which tracks a file has, one audio track as
 * short playable pieces, and a subtitle track as cues. The file's header is kept for a few minutes so the pieces of one viewing do not each
 * read it again.
 */
import { and, eq, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { createStorageForServer } from "@/lib/storage/server-storage";
import { TracksError, fetchMoov, readTracks, type ByteRangeFetcher, type Mp4Track } from "./mp4-tracks";
import type { PlayOwnerKind } from "@/lib/player/types";

const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 12;
const cache = new Map<string, { at: number; tracks: Mp4Track[] }>();

export interface TrackFile {
  id: string;
  boxFileId: string;
  sizeBytes: number | null;
}

/** The file with this id, if it is one of this owner's (a part of it, or the browser-friendly copy of a part); otherwise null. */
export async function ownedFile(ownerKind: PlayOwnerKind, ownerId: string, fileId: string): Promise<TrackFile | null> {
  const [row] = await db
    .select({ id: mediaFiles.id, boxFileId: mediaFiles.boxFileId, sizeBytes: mediaFiles.sizeBytes, ownerKind: mediaFiles.ownerKind, ownerId: mediaFiles.ownerId, variantOf: mediaFiles.variantOfMediaFileId })
    .from(mediaFiles)
    .where(eq(mediaFiles.id, fileId))
    .limit(1);
  if (!row) return null;
  if (row.ownerKind === ownerKind && row.ownerId === ownerId) return row;
  if (!row.variantOf) return null;
  const [primary] = await db
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, row.variantOf), or(eq(mediaFiles.ownerId, ownerId)), eq(mediaFiles.ownerKind, ownerKind)))
    .limit(1);
  return primary ? row : null;
}

/** A byte-range reader for one file, using one download address for every read. */
export async function fileReader(serverId: string, file: TrackFile): Promise<{ fetchRange: ByteRangeFetcher; size: number }> {
  if (!file.sizeBytes) throw new TracksError("This file's size isn't known yet.");
  const { url } = await createStorageForServer(serverId).getStreamingUrl(file.boxFileId);
  const fetchRange: ByteRangeFetcher = async (start, end) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok && res.status !== 206) throw new TracksError(`The file couldn't be read (${res.status}).`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > end - start + 1 + 1024) {
      await res.body?.cancel();
      throw new TracksError("The storage service ignored a range request.");
    }
    return res.arrayBuffer();
  };
  return { fetchRange, size: file.sizeBytes };
}

/** The tracks of a file (header read once, then kept briefly). */
export async function tracksOf(serverId: string, file: TrackFile): Promise<{ tracks: Mp4Track[]; fetchRange: ByteRangeFetcher }> {
  const { fetchRange, size } = await fileReader(serverId, file);
  const hit = cache.get(file.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { tracks: hit.tracks, fetchRange };
  const tracks = readTracks(await fetchMoov(fetchRange, size)).tracks;
  cache.set(file.id, { at: Date.now(), tracks });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return { tracks, fetchRange };
}
