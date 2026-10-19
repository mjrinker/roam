/**
 * Reads the GPS position (latitude and longitude only) from pictures that were scanned before Roam read it, and saves it where one is found.
 * New scans do this by themselves. A place set by hand is never touched. Pictures without a position are read again if this is run again.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-gps.ts [--library <libraryId>] [--dry-run]
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { readImageMeta } from "@/lib/scan/image-meta";
import { createStorageForServer } from "@/lib/storage/server-storage";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const CONCURRENCY = 4;

(async () => {
  const dry = args.includes("--dry-run");
  const only = flag("--library");
  const libs = await db.select({ id: libraries.id, serverId: libraries.serverId, name: libraries.name }).from(libraries).where(and(eq(libraries.kind, "photos"), ...(only ? [eq(libraries.id, only)] : [])));
  for (const lib of libs) {
    const provider = createStorageForServer(lib.serverId);
    const rows = await db
      .select({ id: titles.id, fileId: mediaFiles.boxFileId, size: mediaFiles.sizeBytes })
      .from(titles)
      .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
      .where(and(eq(titles.libraryId, lib.id), eq(titles.kind, "photo"), isNull(titles.placeSource), isNull(titles.latitude), isNotNull(mediaFiles.sizeBytes)));
    let found = 0;
    let done = 0;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(async (r) => {
          try {
            const meta = await readImageMeta((s, e) => provider.fetchByteRange(r.fileId, s, e), r.size as number);
            if (meta.gps) {
              found++;
              if (!dry) await db.update(titles).set({ latitude: meta.gps.latitude, longitude: meta.gps.longitude, placeSource: "exif" }).where(and(eq(titles.id, r.id), isNull(titles.placeSource)));
            }
          } catch (err) {
            console.error(`  ${r.fileId}: ${(err as Error).message}`);
          }
        })
      );
      done = Math.min(rows.length, i + CONCURRENCY);
      if (done % 200 < CONCURRENCY) console.log(`  ${lib.name}: ${done}/${rows.length}, ${found} with a position`);
    }
    console.log(`${lib.name}: ${rows.length} read, ${found} have a position${dry ? " (dry run, nothing saved)" : ", saved"}.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
