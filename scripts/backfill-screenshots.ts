/**
 * Marks the screenshots among pictures scanned before Roam knew about them, so profiles that hide screenshots don't see them. New scans do this by
 * themselves. A picture is a screenshot by its name, or a PNG with no camera date at the exact size of a phone, tablet or laptop screen (see
 * lib/photos/screenshots). (An iPhone's own "Screenshot" note inside a JPEG or HEIC is only read from the next scan of that picture.)
 *
 *   npx tsx --env-file=.env.local scripts/backfill-screenshots.ts [--library <libraryId>] [--dry-run]
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { detectScreenshot } from "@/lib/photos/screenshots";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

(async () => {
  const dry = args.includes("--dry-run");
  const only = flag("--library");
  const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(and(eq(libraries.kind, "photos"), ...(only ? [eq(libraries.id, only)] : [])));
  for (const lib of libs) {
    const rows = await db
      .select({ id: titles.id, filename: mediaFiles.filename, container: mediaFiles.container, width: titles.width, height: titles.height, source: titles.takenAtSource })
      .from(titles)
      .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
      .where(and(eq(titles.libraryId, lib.id), eq(titles.kind, "photo"), eq(titles.isScreenshot, false)));
    const found = rows.filter((r) => detectScreenshot({ filename: r.filename ?? "", container: r.container, width: r.width, height: r.height, hasCameraDate: r.source === "exif" }));
    if (!dry) for (let i = 0; i < found.length; i += 500) await db.update(titles).set({ isScreenshot: true }).where(inArray(titles.id, found.slice(i, i + 500).map((f) => f.id)));
    console.log(`${lib.name}: ${found.length} of ${rows.length} pictures are screenshots${dry ? " (dry run, nothing saved)" : ", marked"}.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
