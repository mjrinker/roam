/**
 * Builds profanity mutes (sound-only "language" scenes) for the movies and episodes already in Roam, from OpenSubtitles subtitles, a few at a
 * time: each file takes one search and one download from the account's daily allowance, so a big library takes days. Run it again whenever
 * the allowance has reset; files already done are skipped. Only the mute times are saved, never the subtitle text. A subtitle file placed
 * beside a video (see the README) is always used in preference and is never overwritten.
 *
 *   npx tsx --env-file=.env.local scripts/build-language-filters.ts --dry-run          (what it would do)
 *   npx tsx --env-file=.env.local scripts/build-language-filters.ts --limit 20
 *
 * Options: --limit N (default 10)  --only movies|shows  --title "name"  --loose (accept the best subtitle for the film when none was made
 * for this exact file; marked as a guess, and its timing may be off)  --retry (try again the files that found no match more than 30 days ago)
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { buildLanguageCues } from "@/lib/subtitles/language-build";
import { OpenSubtitles, openSubtitlesConfig } from "@/lib/subtitles/opensubtitles";
import { searchTarget } from "@/lib/subtitles/service";
import { createStorageForServer } from "@/lib/storage/server-storage";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

async function main() {
  const limit = Math.max(1, Number(arg("--limit") ?? 10));
  const only = arg("--only");
  const titleFilter = arg("--title")?.toLowerCase();
  const dry = flag("--dry-run");
  const config = openSubtitlesConfig();
  if (!config && !dry) throw new Error("OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD must be set in .env.local.");
  const notDone = flag("--retry")
    ? or(isNull(mediaFiles.languageBuiltAt), and(isNull(mediaFiles.languageSource), lt(mediaFiles.languageBuiltAt, new Date(Date.now() - 30 * DAY))))
    : isNull(mediaFiles.languageBuiltAt);
  const base = and(isNull(mediaFiles.variantOfMediaFileId), notDone, sql`${mediaFiles.container} in ('mp4','m4v','mov')`, sql`${mediaFiles.sizeBytes} >= 131072`, sql`${mediaFiles.durationSeconds} is not null`);

  type Candidate = { name: string; owner: { kind: "title" | "episode"; id: string }; fileId: string; filename: string; sizeBytes: number; durationSeconds: number; serverId: string };
  const movies: Candidate[] = only === "shows" ? [] : (
    await db
      .select({ name: titles.name, id: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename, sizeBytes: mediaFiles.sizeBytes, durationSeconds: mediaFiles.durationSeconds, serverId: libraries.serverId })
      .from(mediaFiles)
      .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id)))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(base, eq(titles.kind, "movie"), inArray(libraries.kind, ["movies"]), eq(mediaFiles.versionLabel, "")))
  ).map((r) => ({ name: r.name, owner: { kind: "title" as const, id: r.id }, fileId: r.fileId, filename: r.filename, sizeBytes: r.sizeBytes!, durationSeconds: r.durationSeconds!, serverId: r.serverId }));
  const eps: Candidate[] = only === "movies" ? [] : (
    await db
      .select({ name: titles.name, season: seasons.number, ep: episodes.number, id: episodes.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename, sizeBytes: mediaFiles.sizeBytes, durationSeconds: mediaFiles.durationSeconds, serverId: libraries.serverId })
      .from(mediaFiles)
      .innerJoin(episodes, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(base, eq(mediaFiles.versionLabel, "")))
  ).map((r) => ({ name: `${r.name} S${r.season}E${r.ep}`, owner: { kind: "episode" as const, id: r.id }, fileId: r.fileId, filename: r.filename, sizeBytes: r.sizeBytes!, durationSeconds: r.durationSeconds!, serverId: r.serverId }));
  // A combined multi-episode file has several rows: one try for it.
  const seen = new Set<string>();
  const all = [...movies, ...eps].filter((c) => !seen.has(c.fileId) && seen.add(c.fileId) && (!titleFilter || c.name.toLowerCase().includes(titleFilter)));
  const todo = all.slice(0, limit);
  console.log(`${all.length} files still need mutes built; doing ${todo.length}${dry ? " (dry run)" : ""}.`);
  if (dry) {
    for (const c of todo) console.log(`  ${c.name}  |  ${c.filename}`);
    process.exit(0);
  }

  const os = new OpenSubtitles(config!);
  const counts: Record<string, number> = {};
  let remaining: number | null = null;
  for (const c of todo) {
    const target = await searchTarget(db, c.owner);
    if (!target) continue;
    const provider = createStorageForServer(c.serverId);
    const out = await buildLanguageCues({ os, fetchRange: (s, e) => provider.fetchByteRange(c.fileId, s, e) }, { target, sizeBytes: c.sizeBytes, durationSeconds: c.durationSeconds, loose: flag("--loose") });
    counts[out.status] = (counts[out.status] ?? 0) + 1;
    if (out.status === "quota") {
      console.log("The daily OpenSubtitles download limit is reached. Run this again after it resets.");
      break;
    }
    if (out.status === "error") {
      console.log(`  ! ${c.name}: ${out.message}`);
      continue;
    }
    const same = and(eq(mediaFiles.boxFileId, c.fileId), isNull(mediaFiles.variantOfMediaFileId), or(isNull(mediaFiles.languageSource), sql`${mediaFiles.languageSource} <> 'srt'`));
    if (out.status === "built") {
      remaining = out.remaining;
      await db.update(mediaFiles).set({ languageCues: out.cues.length > 0 ? out.cues : null, languageSource: out.guess ? "opensubtitles-guess" : "opensubtitles", languageBuiltAt: new Date() }).where(same);
      console.log(`  ${out.guess ? "~" : "+"} ${c.name}: ${out.cues.length} mutes${out.guess ? " (a guess: timing may be off)" : ""}`);
    } else {
      // Tried and found nothing usable: noted, so it is not tried again every run.
      await db.update(mediaFiles).set({ languageCues: null, languageSource: null, languageBuiltAt: new Date() }).where(same);
      console.log(`  - ${c.name}: ${out.status === "unmatched" ? "no subtitle made for this exact file" : out.status}`);
    }
    await sleep(1200);
  }
  console.log(`\nDone: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}.${remaining !== null ? ` ${remaining} downloads left today.` : ""}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
