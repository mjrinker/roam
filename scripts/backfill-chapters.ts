/**
 * Reads the chapters inside every movie and episode already in Roam (scans do this a little at a time; this does it all now).
 * Each file costs a few range requests; nothing is downloaded. Safe to re-run, and to stop: files already read are not read again.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-chapters.ts [--limit 500]
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { pendingChapterReadCondition, readChaptersForPending } from "@/lib/scan/media-files";
import { createStorageForServer } from "@/lib/storage/server-storage";

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const movieFiles = await db
    .select({ file: mediaFiles, serverId: libraries.serverId })
    .from(mediaFiles)
    .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id)))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(pendingChapterReadCondition, inArray(libraries.kind, ["movies", "video"])));
  const episodeFiles = await db
    .select({ file: mediaFiles, serverId: libraries.serverId })
    .from(mediaFiles)
    .innerJoin(episodes, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(pendingChapterReadCondition);
  const all = [...movieFiles, ...episodeFiles].slice(0, limit);
  console.log(`${all.length} videos to read`);
  const byServer = new Map<string, typeof all>();
  for (const r of all) byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);
  let done = 0;
  for (const [serverId, rows] of byServer) {
    const provider = createStorageForServer(serverId);
    // In slices, so progress shows and a stop loses little.
    for (let i = 0; i < rows.length; i += 25) {
      await readChaptersForPending(provider, rows.slice(i, i + 25).map((r) => r.file), Date.now() + 10 * 60_000);
      done += Math.min(25, rows.length - i);
      console.log(`... ${done}/${all.length}`);
    }
  }
  const [{ n }] = await db.select({ n: count() }).from(mediaFiles).where(eq(mediaFiles.chaptersSource, "embedded"));
  console.log(`Done. ${n} files now have chapters.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
