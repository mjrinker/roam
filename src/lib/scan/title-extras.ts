/** A movie's extras (trailers, featurettes ...): found in its Box folder by Plex's naming and kept in step with it on every scan. */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titleExtras } from "@/lib/db/schema";
import { extraCategoryOfFile, extraCategoryOfFolder, extraDisplayName, type ExtraCategory } from "@/lib/extras/categories";
import { isBrowserFriendlyVariant, isVideoFile } from "@/lib/scan/conventions";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";

export interface FoundExtra {
  entry: StorageEntry;
  category: ExtraCategory;
  name: string;
}

/**
 * The extras in a movie folder's listing: files named with a type suffix, and the videos inside subfolders named for a type (one
 * level down, as Plex does). `complete` is false when a subfolder couldn't be listed, in which case nothing may be removed on that
 * evidence.
 */
export async function findExtras(provider: Pick<StorageProvider, "listFolder">, children: StorageEntry[]): Promise<{ found: FoundExtra[]; complete: boolean }> {
  const found: FoundExtra[] = [];
  const seen = new Set<string>();
  const add = (entry: StorageEntry, category: ExtraCategory) => {
    if (seen.has(entry.id) || !isVideoFile(entry.name) || isBrowserFriendlyVariant(entry.name)) return;
    seen.add(entry.id);
    found.push({ entry, category, name: extraDisplayName(entry.name) });
  };
  for (const c of children) {
    if (c.kind !== "file") continue;
    const category = extraCategoryOfFile(c.name);
    if (category) add(c, category);
  }
  let complete = true;
  for (const folder of children) {
    if (folder.kind !== "folder") continue;
    const category = extraCategoryOfFolder(folder.name);
    if (!category) continue;
    try {
      for (const f of await provider.listFolder(folder.id)) if (f.kind === "file") add(f, category);
    } catch {
      complete = false;
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.entry.id.localeCompare(b.entry.id));
  return { found, complete };
}

/** Makes a title's extras match what was found: new ones added, renamed ones updated, gone ones removed (with their files' records). */
export async function syncTitleExtras(titleId: string, found: FoundExtra[], complete = true): Promise<void> {
  await db.transaction(async (tx) => {
    const ids = found.map((f) => f.entry.id);
    if (complete) {
      const stale = await tx
        .select({ id: titleExtras.id })
        .from(titleExtras)
        .where(and(eq(titleExtras.titleId, titleId), ids.length > 0 ? notInArray(titleExtras.boxFileId, ids) : undefined));
      if (stale.length > 0) {
        const staleIds = stale.map((s) => s.id);
        await tx.delete(mediaFiles).where(and(eq(mediaFiles.ownerKind, "extra"), inArray(mediaFiles.ownerId, staleIds)));
        await tx.delete(titleExtras).where(inArray(titleExtras.id, staleIds));
      }
    }
    for (const f of found) {
      const [row] = await tx
        .insert(titleExtras)
        .values({ titleId, category: f.category, name: f.name, boxFileId: f.entry.id })
        .onConflictDoUpdate({ target: [titleExtras.titleId, titleExtras.boxFileId], set: { category: f.category, name: f.name } })
        .returning({ id: titleExtras.id });
      await tx
        .insert(mediaFiles)
        .values({
          ownerKind: "extra",
          ownerId: row.id,
          partIndex: 0,
          boxFileId: f.entry.id,
          filename: f.entry.name,
          sizeBytes: f.entry.sizeBytes,
          container: f.entry.name.slice(f.entry.name.lastIndexOf(".") + 1).toLowerCase(),
        })
        .onConflictDoUpdate({
          target: [mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId],
          set: { filename: f.entry.name, sizeBytes: f.entry.sizeBytes },
        });
    }
  });
}
