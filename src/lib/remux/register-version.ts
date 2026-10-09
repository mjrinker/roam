/**
 * Adding the files that scripts/make-versions-box.ts uploads to Roam's records at once, so no rescan is needed. A problem here is
 * reported through `warn` and never thrown: a rescan would find the file anyway.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import { resolveEpisodeSplits } from "@/lib/scan/episode-split-pass";
import { splitVersionLabel } from "@/lib/scan/conventions";
import { probeFiles, rollupTitleRuntime, upsertVariant } from "@/lib/scan/media-files";
import type { StorageProvider } from "@/lib/storage/provider";

export type Owner = { kind: "title" | "episode"; id: string };

/**
 * Adds a freshly uploaded version under each movie/episode the original plays for (several for a combined multi-episode file), probes it
 * for its length, size and codecs, and brings episode trims and the movie's runtime up to date.
 * Returns the new rows' ids (for an AAC copy to link to).
 */
export async function registerVersion(provider: StorageProvider, owners: Owner[], name: string, uploaded: { id: string; size: number }, warn: (m: string) => void = console.warn): Promise<string[]> {
  try {
    const label = splitVersionLabel(name).label;
    const ids: string[] = [];
    for (const o of owners) {
      const [row] = await db
        .insert(mediaFiles)
        .values({ ownerKind: o.kind, ownerId: o.id, partIndex: 0, versionLabel: label, boxFileId: uploaded.id, filename: name, sizeBytes: uploaded.size, container: "mp4" })
        .onConflictDoUpdate({
          target: [mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId],
          set: { partIndex: 0, versionLabel: label, filename: name, sizeBytes: uploaded.size },
        })
        .returning({ id: mediaFiles.id });
      ids.push(row.id);
    }
    const rows = await db.select().from(mediaFiles).where(inArray(mediaFiles.id, ids));
    const errors: string[] = [];
    await probeFiles(provider, rows, Date.now() + 180_000, errors);
    if (errors.length) warn(`   added to Roam, but reading it failed (${errors[0]}); a rescan will retry`);
    const episodeIds = owners.filter((o) => o.kind === "episode").map((o) => o.id);
    if (episodeIds.length) await resolveEpisodeSplits(episodeIds);
    for (const o of owners) if (o.kind === "title") await rollupTitleRuntime(o.id);
    return ids;
  } catch (err) {
    warn(`   couldn't add "${name}" to Roam (${(err as Error).message.split("\n")[0]}); a rescan will pick it up`);
    return [];
  }
}

/** Links an uploaded AAC copy to the version it belongs to and probes it, so playback can use it straight away. */
export async function registerAacCopy(provider: StorageProvider, primaryIds: string[], name: string, uploaded: { id: string; size: number }, warn: (m: string) => void = console.warn): Promise<void> {
  if (primaryIds.length === 0) return;
  try {
    await upsertVariant(primaryIds, { id: uploaded.id, name, sizeBytes: uploaded.size });
    const rows = await db.select().from(mediaFiles).where(and(eq(mediaFiles.boxFileId, uploaded.id), isNotNull(mediaFiles.variantOfMediaFileId)));
    const errors: string[] = [];
    await probeFiles(provider, rows, Date.now() + 120_000, errors);
    if (errors.length) warn(`   its AAC copy is linked, but reading it failed (${errors[0]}); a rescan will retry`);
  } catch (err) {
    warn(`   couldn't link "${name}" in Roam (${(err as Error).message.split("\n")[0]}); a rescan will pick it up`);
  }
}
