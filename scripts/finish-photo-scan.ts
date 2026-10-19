/**
 * Keeps scanning a photo library from this computer until it is complete (dates from each picture's own EXIF, sizes), instead of waiting for
 * the background passes on the server (about 100 pictures a pass).
 *
 *   npx tsx --env-file=.env.local scripts/finish-photo-scan.ts --library <libraryId>
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { scanLibrary } from "@/lib/scan/scanner";

const args = process.argv.slice(2);
(async () => {
  const libraryId = args[args.indexOf("--library") + 1];
  if (!libraryId) throw new Error("usage: finish-photo-scan.ts --library <libraryId>");
  for (let pass = 1; pass <= 200; pass++) {
    const result = await scanLibrary(libraryId, "manual", 0);
    const [lib] = await db.select({ incomplete: libraries.scanIncomplete }).from(libraries).where(eq(libraries.id, libraryId));
    console.log(`pass ${pass}:`, JSON.stringify(result).slice(0, 160), "incomplete =", lib?.incomplete);
    if (!lib?.incomplete) break;
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
