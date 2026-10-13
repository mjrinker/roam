/**
 * Chapter files beside movies and episodes ("Movie (2020).chapters.xml", see lib/chapters/parse): read on every scan of the folder and
 * stored on the video's media_files rows (chapters_source = 'file'), where they outrank the chapters inside the video. Removing the file
 * hands the video back to its own chapters.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { chapterFileVideoBase, isChapterFile, parseChapterFile } from "@/lib/chapters/parse";
import { cleanChapters } from "@/lib/chapters/chapters";
import { isBrowserFriendlyVariant, isExtraFile, isVideoFile } from "@/lib/scan/conventions";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";

/** A chapter file is a few KB; anything bigger is read only up to here. */
const MAX_READ_BYTES = 256 * 1024;
/** When a video has several chapter files, the better-defined format wins. */
const FORMAT_RANK: Record<string, number> = { xml: 0, vtt: 1, txt: 2 };

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "").toLowerCase();
const extOf = (fileName: string) => fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();

/** Which chapter file (if any) belongs to each video in a folder listing, matched on the video's name without its extension. */
export function matchChapterFiles(children: StorageEntry[]): { file: StorageEntry; chapterFile: StorageEntry | null }[] {
  const files = children.filter((c) => c.kind === "file");
  const chapterFiles = files.filter((f) => isChapterFile(f.name));
  return files
    .filter((f) => isVideoFile(f.name) && !isExtraFile(f.name) && !isBrowserFriendlyVariant(f.name))
    .map((file) => {
      const mine = chapterFiles
        .filter((c) => chapterFileVideoBase(c.name)?.toLowerCase() === baseName(file.name))
        .sort((a, b) => (FORMAT_RANK[extOf(a.name)] ?? 9) - (FORMAT_RANK[extOf(b.name)] ?? 9) || a.name.localeCompare(b.name));
      return { file, chapterFile: mine[0] ?? null };
    });
}

/** Brings the stored chapters of this folder's videos in line with the chapter files beside them. Never throws for one bad file. */
export async function syncChapterFiles(provider: Pick<StorageProvider, "fetchByteRange">, children: StorageEntry[]): Promise<void> {
  for (const { file: video, chapterFile } of matchChapterFiles(children)) {
    try {
      if (!chapterFile) {
        // No chapter file: if one used to provide this video's chapters, hand it back to the chapters inside the video.
        await db
          .update(mediaFiles)
          .set({ chapters: null, chaptersSource: null, chaptersReadAt: null })
          .where(and(eq(mediaFiles.boxFileId, video.id), eq(mediaFiles.chaptersSource, "file"), isNull(mediaFiles.variantOfMediaFileId)));
        continue;
      }
      const size = chapterFile.sizeBytes ?? MAX_READ_BYTES;
      const bytes = await provider.fetchByteRange(chapterFile.id, 0, Math.max(0, Math.min(size, MAX_READ_BYTES) - 1));
      const chapters = cleanChapters(parseChapterFile(chapterFile.name, new TextDecoder("utf-8").decode(bytes)));
      if (chapters.length === 0) continue; // unreadable or empty: the video keeps whatever it had
      await db
        .update(mediaFiles)
        .set({ chapters, chaptersSource: "file", chaptersReadAt: new Date() })
        .where(and(eq(mediaFiles.boxFileId, video.id), isNull(mediaFiles.variantOfMediaFileId)));
    } catch (err) {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`chapter file for ${video.name}:`, err);
    }
  }
}
