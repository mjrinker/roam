/**
 * Movie Content Filter files beside movies and episodes ("Movie (2020).mcf"): read on every scan of the folder and stored on the video's
 * media_files rows as scenes to skip or silence. Like a chapter file, one belongs to the one video it is named after, with times from that
 * file's start (a movie in parts gets one per part); removing the file removes its cues.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { mcfFileVideoBase, parseMcf } from "@/lib/content-filter/mcf";
import { isBrowserFriendlyVariant, isExtraFile, isVideoFile } from "@/lib/scan/conventions";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";

/** A filter file is up to a few hundred KB; anything bigger is read only up to here. */
const MAX_READ_BYTES = 512 * 1024;

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "").toLowerCase();

/** Which .mcf file (if any) belongs to each video in a folder listing, matched on the video's name without its extension. */
export function matchFilterFiles(children: StorageEntry[]): { file: StorageEntry; filterFile: StorageEntry | null }[] {
  const files = children.filter((c) => c.kind === "file");
  const filterFiles = files.filter((f) => mcfFileVideoBase(f.name) !== null);
  return files
    .filter((f) => isVideoFile(f.name) && !isExtraFile(f.name) && !isBrowserFriendlyVariant(f.name))
    .map((file) => ({
      file,
      filterFile: filterFiles.find((c) => mcfFileVideoBase(c.name)!.toLowerCase() === baseName(file.name)) ?? null,
    }));
}

/** Brings the stored cues of this folder's videos in line with the .mcf files beside them. Never throws for one bad file. */
export async function syncContentFilterFiles(provider: Pick<StorageProvider, "fetchByteRange">, children: StorageEntry[]): Promise<void> {
  for (const { file, filterFile } of matchFilterFiles(children)) {
    try {
      if (!filterFile) {
        await db.update(mediaFiles).set({ contentCues: null }).where(and(eq(mediaFiles.boxFileId, file.id), isNull(mediaFiles.variantOfMediaFileId)));
        continue;
      }
      const size = filterFile.sizeBytes ?? MAX_READ_BYTES;
      const bytes = await provider.fetchByteRange(filterFile.id, 0, Math.max(0, Math.min(size, MAX_READ_BYTES) - 1));
      const cues = parseMcf(new TextDecoder("utf-8").decode(bytes));
      if (cues.length === 0) continue; // unreadable or empty: the video keeps whatever it had
      await db.update(mediaFiles).set({ contentCues: cues }).where(and(eq(mediaFiles.boxFileId, file.id), isNull(mediaFiles.variantOfMediaFileId)));
    } catch (err) {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`content filter file for ${file.name}:`, err);
    }
  }
}
