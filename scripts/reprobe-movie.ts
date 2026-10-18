/**
 * Reads a movie's files again (lengths, codecs, chapters) after they were replaced in storage, and brings its records up to date.
 *
 *   npx tsx --env-file=.env.local scripts/reprobe-movie.ts --library <libraryId> --folder "David (2025)"
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { scanMovieFolder } from "@/lib/scan/scanner";

const args = process.argv.slice(2);
const flag = (n: string) => args[args.indexOf(n) + 1];

(async () => {
  const libraryId = flag("--library");
  const folder = flag("--folder");
  if (!libraryId || !folder) throw new Error('usage: reprobe-movie.ts --library <id> --folder "Movie (Year)"');
  // First make sure the title exists, then forget what was read from its files, then read them again.
  const first = await scanMovieFolder(libraryId, folder);
  if (!first.titleId) throw new Error("No such title.");
  const own = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, first.titleId)));
  const ids = own.map((r) => r.id);
  const reset = { probeStatus: "pending" as const, probeAttempts: 0, durationSeconds: null, durationMs: null, chapters: null, chaptersSource: null, chaptersReadAt: null, codecProbed: false };
  await db.update(mediaFiles).set(reset).where(or(inArray(mediaFiles.id, ids), inArray(mediaFiles.variantOfMediaFileId, ids)));
  const again = await scanMovieFolder(libraryId, folder);
  console.log(JSON.stringify(again));
  const [t] = await db.select({ duration: titles.runtimeSeconds }).from(titles).where(eq(titles.id, first.titleId));
  console.log("title length now", t?.duration, "seconds");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
