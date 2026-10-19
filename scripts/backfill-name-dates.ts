/**
 * Gives pictures that already have no date of their own (no EXIF) the date in their file name, where there is one ("IMG_20190314_142530.jpg").
 * New scans do this by themselves; this catches the pictures read before that existed. Never touches a date from EXIF or one set by hand.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-name-dates.ts [--library <libraryId>] [--dry-run]
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { parseFilenameDate } from "@/lib/photos/filename-date";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

(async () => {
  const library = flag("--library");
  const dry = args.includes("--dry-run");
  const rows = await db
    .select({ id: titles.id, filename: mediaFiles.filename })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(and(eq(titles.kind, "photo"), inArray(titles.takenAtSource, ["box", "scan"]), isNotNull(titles.metaAttemptedAt), ...(library ? [eq(titles.libraryId, library)] : [])));
  let changed = 0;
  for (const r of rows) {
    const at = parseFilenameDate(r.filename ?? "");
    if (!at) continue;
    changed++;
    if (!dry) await db.update(titles).set({ takenAt: at, takenAtSource: "name", updatedAt: new Date() }).where(and(eq(titles.id, r.id), inArray(titles.takenAtSource, ["box", "scan"])));
  }
  console.log(`${rows.length} pictures without a date of their own; ${changed} have one in the name${dry ? " (dry run, nothing changed)" : ", now used"}.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
