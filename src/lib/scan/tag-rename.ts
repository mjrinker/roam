import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { createBoxProviderForServer, renameBoxEntry } from "@/lib/storage/box";
import { fileNameWithTmdbId, folderNameWithTmdbId, isExtraFile, isVideoFile } from "@/lib/scan/conventions";

/**
 * After an admin picks a TMDB match, stamps `{tmdb-<id>}` onto the title's
 * Box folder (and, for a movie, its video files) so a later rescan
 * force-matches the same title instead of re-guessing. Every rename is
 * best-effort: returns the failures so the match itself still succeeds.
 */
export async function stampTmdbIdOnBox(
  serverId: string,
  title: { kind: "movie" | "show"; boxFolderId: string },
  tmdbId: number
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const provider = createBoxProviderForServer(serverId);

  try {
    const folder = await provider.getFolder(title.boxFolderId);
    if (!folder) return { errors: ["The title's Box folder no longer exists."] };
    const folderName = folderNameWithTmdbId(folder.name, tmdbId);
    if (folderName !== folder.name) await renameBoxEntry(serverId, "folder", folder.id, folderName);
  } catch (err) {
    errors.push(`folder: ${(err as Error).message}`);
  }

  // Episode files keep their Plex "Show - s01e01" names; the show folder's tag is what counts there.
  if (title.kind === "movie") {
    try {
      const children = await provider.listFolder(title.boxFolderId);
      for (const file of children) {
        if (file.kind !== "file" || !isVideoFile(file.name) || isExtraFile(file.name)) continue;
        const name = fileNameWithTmdbId(file.name, tmdbId);
        if (name === file.name) continue;
        try {
          await renameBoxEntry(serverId, "file", file.id, name);
          await db.update(mediaFiles).set({ filename: name }).where(eq(mediaFiles.boxFileId, file.id));
        } catch (err) {
          errors.push(`${file.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`files: ${(err as Error).message}`);
    }
  }

  return { errors };
}
