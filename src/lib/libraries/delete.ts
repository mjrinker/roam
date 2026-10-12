/**
 * Removing a library from Roam: its items, their files' records, watch history, playlist spots, pictures, music and the library itself.
 * Nothing in anybody's storage is touched, and everything else on the server (other libraries, accounts, connections) stays.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titleExtras, titles, watchState } from "@/lib/db/schema";
import { releaseArtwork } from "@/lib/scan/artwork-store";

const CHUNK = 400;

export async function deleteLibrary(libraryId: string): Promise<{ titles: number }> {
  const ids = (await db.select({ id: titles.id }).from(titles).where(eq(titles.libraryId, libraryId))).map((t) => t.id);

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await db.transaction(async (tx) => {
      const seasonIds = (await tx.select({ id: seasons.id }).from(seasons).where(inArray(seasons.titleId, chunk))).map((s) => s.id);
      const episodeIds = seasonIds.length ? (await tx.select({ id: episodes.id }).from(episodes).where(inArray(episodes.seasonId, seasonIds))).map((e) => e.id) : [];
      const extraIds = (await tx.select({ id: titleExtras.id }).from(titleExtras).where(inArray(titleExtras.titleId, chunk))).map((e) => e.id);
      const owners = [
        { kind: "title" as const, ids: chunk },
        { kind: "episode" as const, ids: episodeIds },
        { kind: "extra" as const, ids: extraIds },
      ].filter((o) => o.ids.length > 0);

      for (const { kind, ids: ownerIds } of owners) {
        // A remuxed copy has no owner of its own: it hangs off its primary's row, so it goes first.
        await tx.delete(mediaFiles).where(inArray(mediaFiles.variantOfMediaFileId, tx.select({ id: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.ownerKind, kind), inArray(mediaFiles.ownerId, ownerIds)))));
        await tx.delete(mediaFiles).where(and(eq(mediaFiles.ownerKind, kind), inArray(mediaFiles.ownerId, ownerIds)));
        // Watch history is keyed to the item without a foreign key.
        await tx.delete(watchState).where(and(eq(watchState.ownerKind, kind), inArray(watchState.ownerId, ownerIds)));
      }
      await releaseArtwork(tx, chunk);
      await tx.delete(titles).where(and(inArray(titles.id, chunk), eq(titles.libraryId, libraryId)));
    });
  }

  // Sources, access grants, scan history, music, playback speeds and the rest hang off the library and go with it.
  await db.delete(libraries).where(eq(libraries.id, libraryId));
  return { titles: ids.length };
}
