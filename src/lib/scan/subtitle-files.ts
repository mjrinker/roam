/**
 * Subtitle files beside movies and episodes ("Movie (2020).srt", "Movie (2020).en.srt"): read when a folder is scanned and turned into
 * sound-only "language" mutes for the words the subtitles say (lib/content-filter/profanity). Only the mute times are kept, never the
 * subtitle's text; they go in their own column so a rescan of the folder's scene files never wipes them. Removing the file removes them.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { languageCuesFromSubtitles } from "@/lib/content-filter/profanity";
import { subtitleFileParts } from "@/lib/scan/subtitle-names";
import { isBrowserFriendlyVariant, isExtraFile, isVideoFile } from "@/lib/scan/conventions";
import { MAX_SUBTITLE_BYTES, parseSubtitleBytes } from "@/lib/subtitles/cues";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";

export { subtitleFileParts };

/** A folder named "Subs" or "Subtitles" beside the videos holds their subtitle files (Plex 1.41): its files are listed with the folder's own. */
export async function withSubtitleFolders(provider: Pick<StorageProvider, "listFolder">, children: StorageEntry[]): Promise<StorageEntry[]> {
  const more: StorageEntry[] = [];
  for (const folder of children) {
    if (folder.kind !== "folder" || !/^(?:subs|subtitles)$/i.test(folder.name)) continue;
    try {
      more.push(...(await provider.listFolder(folder.id)).filter((e) => e.kind === "file"));
    } catch (err) {
      if (err instanceof StorageReauthRequiredError) throw err;
    }
  }
  return more.length > 0 ? [...children, ...more] : children;
}

const ENGLISH = new Set(["en", "eng", "en-us", "en-gb"]);
const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "").toLowerCase();

/** Which subtitle file (if any) belongs to each video: the same name, English or no language tag, never a "forced" (foreign-parts-only) file. */
export function matchSubtitleFiles(children: StorageEntry[]): { file: StorageEntry; subtitle: StorageEntry | null }[] {
  const files = children.filter((c) => c.kind === "file");
  const subs = files.map((f) => ({ f, parts: subtitleFileParts(f.name) })).filter((s): s is { f: StorageEntry; parts: NonNullable<ReturnType<typeof subtitleFileParts>> } => s.parts !== null && !s.parts.forced && (s.parts.language === null || ENGLISH.has(s.parts.language)));
  return files
    .filter((f) => isVideoFile(f.name) && !isExtraFile(f.name) && !isBrowserFriendlyVariant(f.name))
    .map((file) => ({
      file,
      // A file with no language tag is taken only when there is no tagged English one.
      subtitle: (subs.find((s) => s.parts.base.toLowerCase() === baseName(file.name) && s.parts.language !== null) ?? subs.find((s) => s.parts.base.toLowerCase() === baseName(file.name)))?.f ?? null,
    }));
}

export async function syncSubtitleFiles(provider: Pick<StorageProvider, "fetchByteRange">, children: StorageEntry[]): Promise<void> {
  for (const { file, subtitle } of matchSubtitleFiles(children)) {
    try {
      const [row] = await db.select({ source: mediaFiles.languageSource, builtAt: mediaFiles.languageBuiltAt }).from(mediaFiles).where(and(eq(mediaFiles.boxFileId, file.id), isNull(mediaFiles.variantOfMediaFileId))).limit(1);
      if (!row) continue;
      if (!subtitle) {
        // The subtitle file that gave these mutes is gone: so are they (a set fetched from elsewhere stays).
        if (row.source === "srt") await db.update(mediaFiles).set({ languageCues: null, languageSource: null, languageBuiltAt: null }).where(and(eq(mediaFiles.boxFileId, file.id), isNull(mediaFiles.variantOfMediaFileId)));
        continue;
      }
      // Already built from this file and it hasn't changed since: nothing to read.
      if (row.source === "srt" && row.builtAt && subtitle.modifiedAt && row.builtAt >= subtitle.modifiedAt) continue;
      const size = Math.min(subtitle.sizeBytes ?? MAX_SUBTITLE_BYTES, MAX_SUBTITLE_BYTES);
      const parsed = parseSubtitleBytes(new Uint8Array(await provider.fetchByteRange(subtitle.id, 0, Math.max(0, size - 1))));
      if (!parsed.ok) continue; // unreadable: whatever there was stays
      const cues = languageCuesFromSubtitles(parsed.cues);
      await db
        .update(mediaFiles)
        .set({ languageCues: cues.length > 0 ? cues : null, languageSource: "srt", languageBuiltAt: new Date() })
        .where(and(eq(mediaFiles.boxFileId, file.id), isNull(mediaFiles.variantOfMediaFileId)));
    } catch (err) {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`subtitle file for ${file.name}:`, err);
    }
  }
}
