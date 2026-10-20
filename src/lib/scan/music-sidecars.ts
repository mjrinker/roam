/**
 * Files Plex reads beside a song, picked up when a music folder is scanned (support.plex.tv "Adding Local Lyrics and Artwork for Music files"):
 *  - lyrics: "Song.lrc" (timed) or "Song.txt" (plain), the same name as the song apart from the extension; kept in place of looked-up lyrics, and
 *    dropped again when the file goes;
 *  - cover art: cover, folder, album, default, poster or front, as .jpg, .jpeg, .png or .tbn, in the album's folder, for songs that have no picture
 *    of their own (a picture inside the song's tags, read later, wins).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titleArtwork, titles, trackLyrics } from "@/lib/db/schema";
import { parseLrc } from "@/lib/lyrics/lrc";
import { isAudioFile } from "@/lib/scan/conventions";
import { storeArtwork } from "@/lib/scan/artwork-store";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { decodeSubtitleBytes } from "@/lib/subtitles/cues";

const COVER_NAMES = ["cover", "folder", "album", "default", "poster", "front"];
const COVER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "tbn"]);
const MAX_LYRIC_BYTES = 256 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;

const stem = (name: string) => name.replace(/\.[^.]+$/, "");
const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** The folder's cover picture: the first of Plex's names, in this order. */
export function albumCoverFile(entries: StorageEntry[]): StorageEntry | null {
  const images = entries.filter((e) => e.kind === "file" && COVER_EXTENSIONS.has(extOf(e.name)));
  for (const wanted of COVER_NAMES) {
    const hit = images.find((e) => stem(e.name).toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

/** The lyric file of a song: "Song.lrc" (timed) before "Song.txt". */
export function lyricFileFor(audioName: string, entries: StorageEntry[]): StorageEntry | null {
  const base = stem(audioName).toLowerCase();
  const files = entries.filter((e) => e.kind === "file" && stem(e.name).toLowerCase() === base);
  return files.find((e) => extOf(e.name) === "lrc") ?? files.find((e) => extOf(e.name) === "txt") ?? null;
}

async function read(provider: Pick<StorageProvider, "fetchByteRange">, file: StorageEntry, max: number): Promise<Uint8Array | null> {
  const size = file.sizeBytes ?? max;
  if (size <= 0 || size > max) return null;
  return new Uint8Array(await provider.fetchByteRange(file.id, 0, size - 1));
}

/** Lyrics and cover art for the songs in one directory's listing. A problem with a side file never fails the scan. */
export async function syncMusicSidecars(provider: Pick<StorageProvider, "fetchByteRange">, libraryId: string, entries: StorageEntry[]): Promise<void> {
  const songs = entries.filter((e) => e.kind === "file" && isAudioFile(e.name));
  if (songs.length === 0) return;
  try {
    const rows = await db
      .select({ titleId: titles.id, fileId: mediaFiles.boxFileId })
      .from(mediaFiles)
      .innerJoin(titles, and(eq(titles.id, mediaFiles.ownerId), eq(titles.libraryId, libraryId)))
      .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.partIndex, 0), inArray(mediaFiles.boxFileId, songs.map((s) => s.id))));
    if (rows.length === 0) return;
    const titleOf = new Map(rows.map((r) => [r.fileId, r.titleId]));
    const ids = rows.map((r) => r.titleId);

    // Lyrics.
    const kept = new Map((await db.select().from(trackLyrics).where(inArray(trackLyrics.titleId, ids))).map((l) => [l.titleId, l]));
    for (const song of songs) {
      const titleId = titleOf.get(song.id);
      if (!titleId) continue;
      const file = lyricFileFor(song.name, entries);
      const have = kept.get(titleId);
      if (!file) {
        if (have?.source === "file") await db.delete(trackLyrics).where(eq(trackLyrics.titleId, titleId));
        continue;
      }
      if (have?.source === "file" && have.fileId === file.id && have.fileModifiedAt && file.modifiedAt && have.fileModifiedAt >= file.modifiedAt) continue;
      const bytes = await read(provider, file, MAX_LYRIC_BYTES);
      if (!bytes) continue;
      const text = decodeSubtitleBytes(bytes).replace(/\r\n?/g, "\n").trim();
      if (text === "") continue;
      const timed = extOf(file.name) === "lrc" ? parseLrc(text) : [];
      const synced = timed.length > 0 ? text : null;
      const plain = timed.length > 0 ? timed.map((l) => l.text).join("\n") : text.replace(/\[(?:ar|ti|al|by|offset|length|re|ve):[^\]]*\]\n?/gi, "");
      const now = new Date();
      await db
        .insert(trackLyrics)
        .values({ titleId, synced, plain, instrumental: false, fetchedAt: now, source: "file", fileId: file.id, fileModifiedAt: file.modifiedAt ?? now })
        .onConflictDoUpdate({ target: trackLyrics.titleId, set: { synced, plain, instrumental: false, fetchedAt: now, source: "file", fileId: file.id, fileModifiedAt: file.modifiedAt ?? now } });
    }

    // Cover art for songs with none of their own.
    const cover = albumCoverFile(entries);
    if (cover) {
      const art = new Map((await db.select({ titleId: titleArtwork.titleId, source: titleArtwork.source, updatedAt: titleArtwork.updatedAt }).from(titleArtwork).where(inArray(titleArtwork.titleId, ids))).map((a) => [a.titleId, a]));
      const needs = ids.filter((id) => {
        const a = art.get(id);
        return !a || (a.source === "box" && cover.modifiedAt !== undefined && a.updatedAt < cover.modifiedAt);
      });
      if (needs.length > 0) {
        const bytes = await read(provider, cover, MAX_COVER_BYTES);
        if (bytes) {
          const image = { contentType: extOf(cover.name) === "png" ? ("image/png" as const) : ("image/jpeg" as const), bytes };
          for (const id of needs) await storeArtwork(db, id, image, "box");
        }
      }
    }
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) throw err;
    console.error("music side files:", err);
  }
}
