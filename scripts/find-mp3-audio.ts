/**
 * Lists the movies and episodes whose video files carry MP3 audio inside the MP4 (filed as "mp4a", so Roam's stored codec doesn't tell);
 * iOS plays such files without sound. Reads each file's header over Box range requests (nothing is downloaded). Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/find-mp3-audio.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { probeMp4Codecs } from "@/lib/scan/mp4-duration";
import { createBoxProviderForServer } from "@/lib/storage/box";

type Row = { name: string; filename: string; boxFileId: string; sizeBytes: number | null; serverId: string; kind: string };

async function main() {
  const base = and(isNull(mediaFiles.variantOfMediaFileId), eq(mediaFiles.audioCodec, "mp4a"), eq(mediaFiles.probeStatus, "ok"), sql`${mediaFiles.sizeBytes} is not null`);
  const movies: Row[] = await db
    .select({ name: titles.name, filename: mediaFiles.filename, boxFileId: mediaFiles.boxFileId, sizeBytes: mediaFiles.sizeBytes, serverId: libraries.serverId, kind: sql<string>`'movie'` })
    .from(mediaFiles).innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id))).innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(base, eq(titles.kind, "movie"), sql`${libraries.kind} in ('movies','video')`));
  const eps: Row[] = await db
    .select({ name: sql<string>`${titles.name} || ' - ' || ${mediaFiles.filename}`, filename: mediaFiles.filename, boxFileId: mediaFiles.boxFileId, sizeBytes: mediaFiles.sizeBytes, serverId: libraries.serverId, kind: sql<string>`'episode'` })
    .from(mediaFiles).innerJoin(episodes, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id))).innerJoin(seasons, eq(episodes.seasonId, seasons.id)).innerJoin(titles, eq(seasons.titleId, titles.id)).innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(base);
  // One file per Box id (a combined multi-episode file has several rows).
  const seen = new Set<string>();
  const rows = [...movies, ...eps].filter((r) => (seen.has(r.boxFileId) ? false : (seen.add(r.boxFileId), true)));
  console.log(`${rows.length} files with mp4a audio to look at`);
  const found: Row[] = [];
  let checked = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    for (;;) {
      const r = rows[next++];
      if (!r) return;
      try {
        const provider = createBoxProviderForServer(r.serverId);
        const c = await probeMp4Codecs((s, e) => provider.fetchByteRange(r.boxFileId, s, e), r.sizeBytes!);
        if (c.audioCodec === "mp3") {
          found.push(r);
          console.log(`MP3  ${r.kind}  ${r.name}  |  ${r.filename}`);
        }
      } catch {
        failed++;
      }
      if (++checked % 200 === 0) console.log(`... ${checked}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`\nChecked ${checked} (${failed} couldn't be read); ${found.length} have MP3 audio.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
