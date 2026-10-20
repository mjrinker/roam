import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entriesAfterCursor,
  planScan,
  sortForScan,
  type ScanCursor,
} from "@/lib/scan/cursor";
import {
  episodes,
  libraries,
  mediaFiles,
  scanRuns,
  seasons,
  titleExtras,
  titles,
  type TitleKind,
} from "@/lib/db/schema";
import { findExtras, syncTitleExtras, type FoundExtra } from "@/lib/scan/title-extras";
import { syncChapterFiles } from "@/lib/scan/chapter-files";
import { syncContentFilterFiles } from "@/lib/scan/content-filter-files";
import { syncSubtitleFiles, withSubtitleFolders } from "@/lib/scan/subtitle-files";
import { MOVIE_POSTER_NAMES, posterFile, SHOW_POSTER_NAMES, syncLocalPoster } from "@/lib/scan/local-artwork";
import { decodeSubtitleBytes } from "@/lib/subtitles/cues";
import { emptyPlexMatch, hintForFile, parsePlexMatch, type PlexMatch } from "@/lib/scan/plexmatch";
import { syncSidecarTracks } from "@/lib/subtitles/tracks";
import { createStorageForServer } from "@/lib/storage/server-storage";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  groupByVersion,
  groupEpisodeFiles,
  groupMovieVersions,
  isBrowserFriendlyVariant,
  isExtraFile,
  isUnplayableVideo,
  isVideoFile,
  movieVersionLabeler,
  orderMediaSegments,
  parseEditionTag,
  parseEpisodeAirDate,
  parseEpisodeFileName,
  parseMovieFileTitle,
  parseSeasonFolderName,
  parseTitleFolderName,
  splitVersionLabel,
} from "@/lib/scan/conventions";
import {
  enrichPendingAudiobooks,
  resolveAudiobookChapters,
  resolvePendingAudiobookChapters,
  syncAudiobookTopFolder,
  syncSingleAudiobook,
} from "@/lib/scan/audiobooks";
import { markCycleUnclean, pruneMissingVideos, pruneNote } from "@/lib/scan/video-prune";
import { isFileTreeLibraryKind, libraryKindUsesExternalMetadata } from "@/lib/libraries/profile";
import { treeProfileFor } from "@/lib/scan/tree-profile";
import { conflictNote, probeVideoLibrary, syncVideoDirectory, syncVideoTopFolder, unsupportedSummary } from "@/lib/scan/video-library";
import { resolveEpisodeSplits } from "@/lib/scan/episode-split-pass";
import {
  linkVariantFiles,
  pendingCodecProbeCondition,
  pendingChapterReadCondition,
  readChaptersForPending,
  pendingProbeCondition,
  probeCodecsForPending,
  probeFiles,
  rollupTitleRuntime,
  upsertMediaSegments,
  variantScope,
} from "@/lib/scan/media-files";
import { searchMovie, findTmdbIdByImdbId, findTmdbShowIdByTvdbId, searchTvShow, tmdbImageUrl } from "@/lib/tmdb/client";
// Details come through the shared cache: fetched from TMDB once for every server, and refreshed there (see lib/tmdb/cache).
import { getMovieDetails, getSeasonEpisodes, getTvShowDetails, refreshEntry } from "@/lib/tmdb/cache";
import { collectionColumnsOnMatch } from "@/lib/tmdb/project";
import { ratingsFromMovieDetails, ratingsFromTvDetails } from "@/lib/content/ratings";
import { backfillRatings } from "@/lib/content/ratings-backfill";
import { backfillExternalRatings } from "@/lib/content/external-ratings-backfill";
import { backfillCast } from "@/lib/content/cast-backfill";
import { backfillCollections, syncSeriesCollections } from "@/lib/collections/sync";
import { libraryRootIds, rootLabel } from "@/lib/libraries/sources";

function assertNever(value: never): never {
  throw new Error(`Unhandled kind: ${String(value)}`);
}

export interface ScanResult {
  scanRunId: string;
  filesSeen: number;
  titlesAdded: number;
  errors: string[];
  /** True when this pass hit its time budget; another pass has been scheduled to continue it. */
  incomplete: boolean;
}

// A large library (hundreds of titles, each needing a Box folder listing,
// possibly a TMDB lookup, and multiple byte-range probes) can easily take
// longer than a serverless function is allowed to run — Vercel's Hobby
// plan caps at 60s (up to 300s with Fluid Compute, which isn't guaranteed
// enabled). Rather than assume any specific ceiling, scanLibrary bounds
// its own work by a conservative wall-clock budget and stops cleanly
// before it would be at risk of being killed mid-write. The scan_runs
// bookkeeping always completes correctly either way (a real filesSeen/
// titlesAdded/finishedAt gets written even on an early stop) — a
// still-incomplete library chains straight into another pass (see
// continueScanInBackground), with page-load resume and the scheduled cron
// scan as fallbacks if the chain is ever broken.
const SCAN_TIME_BUDGET_MS = 40_000;
// Safety cap on back-to-back passes (~30 min of scanning) so a library that
// can never finish can't chain forever; the fallbacks above pick it back up.
const MAX_CHAIN_DEPTH = 40;
const ENRICH_TIME_BUDGET_MS = 10_000;
const FOLDER_SYNC_TIME_BUDGET_MS = 24_000; // ~60% of the budget — leaves room for probing to run every pass too, so titles start becoming playable before the whole library has even finished being discovered

/** Scans one library's Box folder tree (using its server's own connected Box account) and syncs it into Postgres. */
export async function scanLibrary(
  libraryId: string,
  trigger: "manual" | "cron" | "webhook" | "resume",
  chainDepth = 0
): Promise<ScanResult> {
  const startedAt = Date.now();
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  if (!library) throw new Error(`Library ${libraryId} not found`);

  // Written BEFORE any Box calls, success or failure — not in a finally
  // block, since a function timeout or hard crash never reaches finally,
  // which would silently reintroduce the exact starvation bug this column
  // exists to prevent (see the cron batching query in api/cron/scan).
  await db
    .update(libraries)
    .set({ lastScanAttemptAt: new Date() })
    .where(eq(libraries.id, libraryId));

  const [run] = await db
    .insert(scanRuns)
    .values({ libraryId, trigger })
    .returning();

  let filesSeen = 0;
  let titlesAdded = 0;
  let unsupportedSkipped = 0;
  let incomplete = false;
  // Set when another scan takes over the cursor mid-pass; this pass then
  // stops without touching the library's scan state.
  let superseded = false;
  const errors: string[] = [];
  const provider = createStorageForServer(library.serverId);

  // File-tree libraries (video, audio, photos) share one scanning engine; this says how the kind differs.
  const treeProfile = isFileTreeLibraryKind(library.kind) ? treeProfileFor(library.kind) : null;

  const plan = planScan(trigger, library);
  let cursor: ScanCursor | null = plan.mode === "continue" ? plan.cursor : null;
  // Video libraries: the scan cycle this pass belongs to. A full pass starts a new one; a continuing
  // pass carries on with the cycle on the library row (null for one begun before cycles existed, which
  // can never remove anything).
  let cycleId: string | null = treeProfile && plan.mode !== "full" ? library.scanCycleId : null;

  try {
    if (plan.mode === "full") {
      // A fresh cycle: unconditional reset, so any in-flight chained pass
      // fails its next compare-and-set and stops rather than fighting us.
      if (treeProfile) cycleId = randomUUID();
      await db
        .update(libraries)
        .set({
          scanCursor: null,
          scanFoldersTotal: 0,
          scanFoldersDone: 0,
          ...(cycleId ? { scanCycleId: cycleId, scanCycleClean: true } : {}),
        })
        .where(eq(libraries.id, libraryId));
    }

    if (plan.mode !== "probe-only") {
      // A video library acts on what the root listing LACKS (it links remuxed copies and counts files), so a silently shortened list must fail the scan, not pass for a smaller library.
      // A library can be made of several folders, on any of the server's storage connections: they are scanned as one. One that can't be
      // read this time (its connection signed out, the folder gone) is reported and skipped, and keeps this cycle from removing anything.
      const roots = await libraryRootIds(library);
      const listings: { root: string; entries: StorageEntry[] }[] = [];
      for (const root of roots) {
        try {
          listings.push({ root, entries: await provider.listFolder(root, treeProfile ? { strict: true } : undefined) });
        } catch (err) {
          if (roots.length === 1) throw err;
          errors.push(`${await rootLabel(root)}: ${(err as Error).message}`);
          if (treeProfile) await markCycleUnclean(library.id, cycleId);
        }
      }
      const topLevel = listings.flatMap((l) => l.entries);
      const sortedFolders = sortForScan(topLevel.filter((e) => e.kind === "folder"));
      const titleFolders = entriesAfterCursor(sortedFolders, cursor);
      if (plan.mode === "full") {
        await db
          .update(libraries)
          .set({ scanFoldersTotal: sortedFolders.length })
          .where(eq(libraries.id, libraryId));
      }

      // A video library's loose files at the top level aren't in any folder, so they're synced once
      // per cycle, up front (idempotent, batched), outside the folder cursor.
      if (treeProfile && plan.mode === "full") {
        for (const listing of listings) {
          try {
            const r = await syncVideoDirectory(library.id, listing.root, "", listing.entries, cycleId, treeProfile);
            if (r.stale) superseded = true;
            titlesAdded += r.added;
            filesSeen += r.seen;
            unsupportedSkipped += r.unsupported;
            if (r.conflicts > 0) errors.push(`(library root): ${conflictNote(r.conflicts)}`);
          } catch (err) {
            if (err instanceof StorageReauthRequiredError) throw err;
            errors.push(`(library root): ${(err as Error).message}`);
            await markCycleUnclean(library.id, cycleId);
          }
        }
      }

      // A movies library may also have its films loose in the top folder, with no folder each (Plex allows it): synced once per cycle, up front.
      if (library.kind === "movies" && plan.mode === "full") {
        for (const listing of listings) {
          try {
            titlesAdded += await syncStandaloneMovies(provider, library.id, listing.entries, (n) => (unsupportedSkipped += n));
          } catch (err) {
            if (err instanceof StorageReauthRequiredError) throw err;
            errors.push(`(library root): ${(err as Error).message}`);
          }
        }
      }

      let processed = 0;
      let loopFinished = true;
      for (const folder of titleFolders) {
        if (superseded) break;
        // Always finish at least one folder per pass so a slow one can't
        // make every pass time out before recording any progress.
        if (processed > 0 && Date.now() - startedAt > FOLDER_SYNC_TIME_BUDGET_MS) {
          incomplete = true;
          loopFinished = false;
          break;
        }
        let stopLoop = false;
        try {
          switch (library.kind) {
            case "movies": {
              const added = await syncMovieFolder(provider, library.id, folder, (n) => (unsupportedSkipped += n));
              if (added) titlesAdded++;
              filesSeen += 1;
              break;
            }
            case "shows": {
              const added = await syncShowFolder(provider, library.id, folder, (n) => (unsupportedSkipped += n));
              if (added) titlesAdded++;
              break;
            }
            case "audiobooks": {
              const res = await syncAudiobookTopFolder(provider, library.id, folder, {
                afterSub: cursor?.folder === folder.name ? (cursor.sub ?? null) : null,
                errors,
                budgetExhausted: () => processed > 0 && Date.now() - startedAt > FOLDER_SYNC_TIME_BUDGET_MS,
                onUnitDone: async (childName) => {
                  const next: ScanCursor = { folder: folder.name, folderId: folder.id, sub: childName };
                  if (!(await advanceScanCursor(libraryId, cursor, next))) return false;
                  cursor = next;
                  processed++;
                  return true;
                },
              });
              titlesAdded += res.titlesAdded;
              filesSeen += res.booksSeen;
              if (res.superseded) {
                superseded = true;
                stopLoop = true;
              } else if (!res.finished) {
                incomplete = true;
                loopFinished = false;
                stopLoop = true;
              }
              break;
            }
            case "photos":
            case "music":
            case "ebooks":
            case "audio":
            case "video": {
              const res = await syncVideoTopFolder(provider, library.id, folder, {
                profile: treeProfile ?? undefined,
                cycleId,
                onError: () => markCycleUnclean(library.id, cycleId),
                afterSub: cursor?.folder === folder.name ? (cursor.sub ?? null) : null,
                errors,
                budgetExhausted: () => processed > 0 && Date.now() - startedAt > FOLDER_SYNC_TIME_BUDGET_MS,
                onUnitDone: async (sub) => {
                  const next: ScanCursor = { folder: folder.name, folderId: folder.id, sub };
                  if (!(await advanceScanCursor(libraryId, cursor, next))) return false;
                  cursor = next;
                  processed++;
                  return true;
                },
              });
              titlesAdded += res.titlesAdded;
              filesSeen += res.filesSeen;
              unsupportedSkipped += res.unsupported;
              if (res.hadErrors) await markCycleUnclean(library.id, cycleId);
              if (res.superseded) {
                superseded = true;
                stopLoop = true;
              } else if (!res.finished) {
                incomplete = true;
                loopFinished = false;
                stopLoop = true;
              }
              break;
            }
            default:
              assertNever(library.kind);
          }
        } catch (err) {
          // A single title's own Box connection dying mid-scan means every
          // OTHER title will fail the same way — short-circuit with one
          // clear error instead of one near-identical message per folder.
          if (err instanceof StorageReauthRequiredError) throw err;
          errors.push(`${folder.name}: ${(err as Error).message}`);
          // This folder was stepped past without being fully seen, so the cycle can't vouch for what's missing.
          if (treeProfile) await markCycleUnclean(library.id, cycleId);
        }
        if (stopLoop) break;
        processed++;

        // Advance even after a per-folder error, so one bad folder can't
        // stall the whole cycle.
        const next: ScanCursor = { folder: folder.name, folderId: folder.id };
        if (!(await advanceScanCursor(libraryId, cursor, next))) {
          superseded = true;
          break;
        }
        cursor = next;
      }

      // Folder loop reached the end: clear the cursor. Folder sync is done
      // for this cycle; any remaining work is probing.
      if (loopFinished && !superseded && !(await advanceScanCursor(libraryId, cursor, null, treeProfile ? cycleId : undefined))) {
        superseded = true;
      }

      // The pass that finishes a clean cycle removes videos that have left Box (see video-prune for every guard).
      if (treeProfile && library.pruneMissing && cycleId && loopFinished && !superseded) {
        const note = pruneNote(await pruneMissingVideos(provider, library.id, cycleId, startedAt + SCAN_TIME_BUDGET_MS, treeProfile), treeProfile);
        if (note) errors.push(note);
      }
    }

    if (!superseded) {
      const probeDeadline = startedAt + SCAN_TIME_BUDGET_MS;
      // Capped so these lookups can't starve probing of the whole pass.
      const enrichDeadline = Math.min(probeDeadline, Date.now() + ENRICH_TIME_BUDGET_MS);
      if (library.kind === "audiobooks") {
        const moreToMatch = await enrichPendingAudiobooks(library.id, library.audibleRegion, enrichDeadline);
        incomplete = incomplete || moreToMatch;
      } else if (treeProfile) {
        // Everything comes from the files themselves: no TMDB, OMDb or Audible lookups, ever.
      } else {
        const moreRatings = await backfillRatings(library.id, enrichDeadline);
        const moreExternalRatings = await backfillExternalRatings(library.id, enrichDeadline);
        const moreCast = await backfillCast(library.id, enrichDeadline);
        // Film series: which collection each movie is in, and the collections that follow from it (only movie libraries have any).
        const moreCollections = library.kind === "movies" ? await backfillCollections(db, library.id, enrichDeadline) : false;
        if (library.kind === "movies") await syncSeriesCollections(db, library.id);
        incomplete = incomplete || moreRatings || moreExternalRatings || moreCast || moreCollections;
      }
      const audibleRegion = library.kind === "audiobooks" ? library.audibleRegion : null;
      const probeIncomplete =
        treeProfile
          ? await probeVideoLibrary(provider, library.id, probeDeadline, errors, treeProfile)
          : await probePendingDurations(provider, library.id, probeDeadline, errors, audibleRegion);
      incomplete = incomplete || probeIncomplete;
    }
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) {
      errors.push("This server's Box connection needs to be reconnected by an admin.");
    } else {
      errors.push((err as Error).message);
    }
  }

  const skippedNote = unsupportedSummary(unsupportedSkipped, treeProfile ?? MOVIES_SHOWS_HINT);
  if (skippedNote) errors.push(skippedNote);
  await db
    .update(scanRuns)
    .set({ finishedAt: new Date(), filesSeen, titlesAdded, errors })
    .where(eq(scanRuns.id, run.id));
  if (superseded) {
    return { scanRunId: run.id, filesSeen, titlesAdded, errors, incomplete: false };
  }

  await db
    .update(libraries)
    .set({ lastScannedAt: new Date(), scanIncomplete: incomplete })
    .where(eq(libraries.id, library.id));

  if (incomplete && chainDepth < MAX_CHAIN_DEPTH) {
    await continueScanInBackground(library.id, chainDepth + 1);
  }

  return { scanRunId: run.id, filesSeen, titlesAdded, errors, incomplete };
}

/**
 * Scans one movie folder of a movies library (a film just added) without walking the whole library: records its title and files, then reads
 * what the files hold (lengths, codecs, chapters) until they are all known, so the movie can play. Returns what happened in words.
 */
export async function scanMovieFolder(libraryId: string, folderName: string): Promise<{ titleId: string | null; added: boolean; errors: string[] }> {
  const [library] = await db.select().from(libraries).where(eq(libraries.id, libraryId)).limit(1);
  if (!library || library.kind !== "movies") throw new Error("That isn't a movies library.");
  const provider = createStorageForServer(library.serverId);
  let folder: StorageEntry | undefined;
  for (const root of await libraryRootIds(library)) {
    folder = (await provider.listFolder(root, { strict: true })).find((e) => e.kind === "folder" && e.name === folderName);
    if (folder) break;
  }
  if (!folder) throw new Error(`No folder named "${folderName}" in that library.`);
  const added = await syncMovieFolder(provider, library.id, folder);
  const [title] = await db.select({ id: titles.id }).from(titles).where(and(eq(titles.libraryId, library.id), eq(titles.boxFolderId, folder.id))).limit(1);
  const errors: string[] = [];
  if (title) {
    for (let pass = 0; pass < 20; pass++) {
      await probeTitlePendingDurations(provider, title.id, "movie", Date.now() + 30_000, errors);
      const pending = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, title.id), pendingProbeCondition)).limit(1);
      if (pending.length === 0) break;
    }
    await backfillCodecs(provider, [title.id], [], Date.now() + 60_000).catch((e) => errors.push((e as Error).message));
    await backfillChapters(provider, [title.id], [], Date.now() + 60_000).catch((e) => errors.push((e as Error).message));
  }
  return { titleId: title?.id ?? null, added, errors };
}

/**
 * Compare-and-set on libraries.scan_cursor: moves it from `from` to `to`
 * only if it still holds `from`. False means another scan advanced or reset
 * it since this pass read it, so this pass no longer owns the cursor.
 */
async function advanceScanCursor(
  libraryId: string,
  from: ScanCursor | null,
  to: ScanCursor | null,
  /** Video libraries: also require the library to still be in this scan cycle, so a pass from an older cycle can't finish (or prune) a newer one. */
  requireCycle?: string | null
): Promise<boolean> {
  // Both sides are cast from JSON text in SQL so the stored value and the
  // comparison can't disagree about how the driver encodes jsonb.
  const fromJson = from ? JSON.stringify(from) : null;
  const toJson = to ? JSON.stringify(to) : null;
  const rows = await db
    .update(libraries)
    .set({
      scanCursor: sql`${toJson}::jsonb`,
      // Whole folders only (a sub-step within an audiobook author folder
      // isn't a finished folder); clearing the cursor means the loop is done.
      ...(to && !to.sub
        ? { scanFoldersDone: sql`${libraries.scanFoldersDone} + 1` }
        : to === null
          ? { scanFoldersDone: libraries.scanFoldersTotal }
          : {}),
    })
    .where(
      and(
        eq(libraries.id, libraryId),
        sql`${libraries.scanCursor} IS NOT DISTINCT FROM ${fromJson}::jsonb`,
        requireCycle ? eq(libraries.scanCycleId, requireCycle) : undefined
      )
    )
    .returning({ id: libraries.id });
  return rows.length > 0;
}

/**
 * Starts the next pass of an incomplete scan as its own function invocation
 * (a fresh time budget). The endpoint replies immediately and does the work
 * in the background, so this only waits for the handoff. Failure is fine:
 * scan_incomplete stays set, so the next page load or cron run resumes it.
 */
async function continueScanInBackground(libraryId: string, depth: number) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!baseUrl || !secret) return;
  try {
    await fetch(new URL("/api/scan/continue", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ libraryId, depth }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`Couldn't chain the next scan pass for library ${libraryId}:`, err);
  }
}

// Skip auto-resuming a library whose last scan attempt was very recent —
// a page load from another tab/user may have already kicked one off, and
// since scanLibrary can legitimately run for most of its own time budget,
// this just avoids piling up redundant concurrent scans of the same
// library (harmless either way, since every write in the scanner is an
// idempotent upsert, just wasted Box/TMDB calls).
const RESUME_COOLDOWN_MS = 60_000;

/** Libraries in this server whose last scan stopped early and are safe to auto-resume right now. */
export async function findResumableLibraries(serverId: string): Promise<string[]> {
  const cutoff = new Date(Date.now() - RESUME_COOLDOWN_MS);
  const rows = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(
      and(
        eq(libraries.serverId, serverId),
        eq(libraries.scanIncomplete, true),
        or(isNull(libraries.lastScanAttemptAt), lt(libraries.lastScanAttemptAt, cutoff))
      )
    );
  return rows.map((r) => r.id);
}

// ── Folder id tags ───────────────────────────────────────────────────────

interface FolderIdTags {
  tmdbId: number | null;
  imdbId: string | null;
}

// OMDb data belongs to the previously matched film; clear it so the backfill re-fetches.
const STALE_EXTERNAL_RATINGS = {
  imdbRating: null,
  imdbVotes: null,
  rottenTomatoesScore: null,
  metascore: null,
  externalRatingsAttemptedAt: null,
} as const;

/**
 * The TMDB id a folder's {tmdb-...}/{imdb-...} tag pins the title to, or
 * null when there's no tag (or an {imdb-...} tag the title already carries,
 * or one TMDB can't resolve). An IMDb tag costs a TMDB lookup only when it
 * differs from what's already matched.
 */
async function resolveForcedTmdbId(
  kind: "movie" | "show",
  tag: FolderIdTags,
  current: { imdbId: string | null }
): Promise<number | null> {
  if (tag.tmdbId) return tag.tmdbId;
  if (tag.imdbId && tag.imdbId !== current.imdbId?.toLowerCase()) {
    return findTmdbIdByImdbId(tag.imdbId, kind).catch(() => null);
  }
  return null;
}

// ── Movies ───────────────────────────────────────────────────────────────

interface MovieGroup {
  /** The title's unique key (titles.boxFolderId): the folder's id, or a name made from it for an extra edition, or a name for a loose file. */
  key: string;
  name: string;
  year: number | null;
  edition: string | null;
  tmdbId: number | null;
  imdbId: string | null;
  files: StorageEntry[];
  /** The movie has a folder of its own, where poster.jpg and the like belong to it (loose files share their listing with other movies). */
  posterFolder?: boolean;
}

// Plex libraries are full of .mkv and .avi, which a browser can't play; they are counted and reported, never silently left out.
const MOVIES_SHOWS_HINT = { supportedHint: "Roam plays .mp4, .m4v and .mov with H.264 video and AAC audio; .mkv, .avi and the like need converting first" };

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Records one movie (or one edition of one): its title, its files as ordered parts of versions, and what its metadata and side files say. */
async function syncMovieGroup(
  provider: StorageProvider,
  libraryId: string,
  g: MovieGroup,
  side: { listing: StorageEntry[]; variants: StorageEntry[]; sideFiles: boolean }
): Promise<{ id: string; added: boolean }> {
  // An edition is part of what the movie is called, so two cuts of one film are told apart in the library.
  const displayName = g.edition ? `${g.name} (${g.edition})` : g.name;
  const [existing] = await db.select({ id: titles.id }).from(titles).where(eq(titles.boxFolderId, g.key)).limit(1);
  const [title] = await db
    .insert(titles)
    .values({ libraryId, kind: "movie", name: displayName, year: g.year, boxFolderId: g.key })
    .onConflictDoUpdate({ target: titles.boxFolderId, set: { name: displayName, year: g.year, updatedAt: new Date() } })
    .returning();

  // Each version ("- 1080p", "- hevc", "- Theatrical": Plex lets it be any text) is its own ordered set of parts, never appended to another's.
  const videoFiles = [...groupMovieVersions(g.files).values()].flatMap((group) => orderMediaSegments(group));
  await upsertMediaSegments("title", title.id, videoFiles, movieVersionLabeler(g.files));
  await linkVariantFiles("title", [title.id], videoFiles, side.variants);
  if (side.sideFiles) {
    // Chapter files beside the film ("Film (2020).chapters.xml"); a failure here never fails the film's own scan.
    await syncChapterFiles(provider, side.listing).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`chapter files for ${title.id}:`, err);
    });
    await syncContentFilterFiles(provider, side.listing).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`content filter files for ${title.id}:`, err);
    });
    const withSubs = await withSubtitleFolders(provider, side.listing);
    await syncSubtitleFiles(provider, withSubs).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`subtitle files for ${title.id}:`, err);
    });
    await syncSidecarTracks(db, withSubs).catch((err) => console.error(`subtitle tracks for ${title.id}:`, err));
  }
  await enrichMovieMetadataIfNeeded(title.id, g.name, g.year, { tmdbId: g.tmdbId, imdbId: g.imdbId });
  // A poster beside the film (poster.jpg and the like in its folder, or a picture named like it) wins over the one TMDB gave.
  if (side.sideFiles) await syncLocalPoster(provider, title.id, posterFile(side.listing, g.posterFolder ? MOVIE_POSTER_NAMES : [], g.files.map((f) => f.name.replace(/\.[^.]+$/, ""))));
  return { id: title.id, added: !existing };
}

/** The video files in a listing that can be a movie's (not extras, not remuxed audio variants), and the variants apart. */
function movieVideoFiles(entries: StorageEntry[], skipped?: (n: number) => void) {
  const files = entries.filter((c) => c.kind === "file");
  skipped?.(files.filter((c) => isUnplayableVideo(c.name)).length);
  const allVideo = files.filter((c) => isVideoFile(c.name) && !isExtraFile(c.name));
  // Remuxed audio variants must be split out BEFORE any segment/edition logic, or they'd be appended to the movie as extra parts.
  return { candidates: allVideo.filter((c) => !isBrowserFriendlyVariant(c.name)), variants: allVideo.filter((c) => isBrowserFriendlyVariant(c.name)) };
}

export async function syncMovieFolder(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry,
  skipped?: (n: number) => void
): Promise<boolean> {
  const { name, year, tmdbId, imdbId, edition: folderEdition } = parseTitleFolderName(folder.name);
  const children = await provider.listFolder(folder.id);
  const { candidates, variants } = movieVideoFiles(children, skipped);

  // Plex: each edition is its own item. A folder can hold several, each file tagged {edition-...} (an edition set on the folder name counts
  // for untagged files); the one that is the folder's own edition (or the first, with none) is the folder's title, the rest get titles of their own.
  const byEdition = new Map<string, StorageEntry[]>();
  for (const file of candidates) {
    const e = parseEditionTag(file.name) ?? folderEdition ?? "";
    byEdition.set(e, [...(byEdition.get(e) ?? []), file]);
  }
  if (byEdition.size === 0) byEdition.set(folderEdition ?? "", []);
  const editions = [...byEdition.keys()].sort((a, b) => a.localeCompare(b));
  const main = byEdition.has(folderEdition ?? "") ? (folderEdition ?? "") : editions[0];

  let mainResult: { id: string; added: boolean } | null = null;
  const keptKeys: string[] = [];
  for (const e of [main, ...editions.filter((x) => x !== main)]) {
    const key = e === main ? folder.id : `${folder.id}#ed:${slug(e)}`;
    keptKeys.push(key);
    const result = await syncMovieGroup(
      provider,
      libraryId,
      { key, name, year, edition: e || null, tmdbId, imdbId, files: byEdition.get(e) ?? [], posterFolder: true },
      { listing: children, variants, sideFiles: e === main }
    );
    if (e === main) mainResult = result;
  }

  // Editions that are no longer in the folder go, with their files' records.
  const stale = await db
    .select({ id: titles.id })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), like(titles.boxFolderId, `${folder.id}#ed:%`), notInArray(titles.boxFolderId, keptKeys)));
  if (stale.length > 0) {
    const ids = stale.map((t) => t.id);
    await db.delete(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, ids)));
    await db.delete(titles).where(inArray(titles.id, ids));
  }

  // Trailers, featurettes and the like (Plex's naming) sit beside the film; a failure here never fails the film's own scan.
  try {
    const extras = await findExtras(provider, children);
    await syncTitleExtras(mainResult!.id, extras.found, extras.complete);
  } catch (err) {
    console.error(`extras for ${mainResult!.id}:`, err);
  }
  return mainResult!.added;
}

/**
 * Movie files loose in the library's top folder ("Avatar (2009).mkv", "Blade Runner (1982) {edition-Final Cut}.mp4"): Plex allows them beside
 * each other with no folder of their own. Files naming the same movie (and edition) are its versions and parts. Returns how many movies were new.
 */
export async function syncStandaloneMovies(provider: StorageProvider, libraryId: string, entries: StorageEntry[], skipped?: (n: number) => void): Promise<number> {
  const { candidates, variants } = movieVideoFiles(entries, skipped);
  const groups = new Map<string, MovieGroup>();
  for (const file of candidates) {
    const parsed = parseMovieFileTitle(file.name);
    const edition = parseEditionTag(file.name) ?? parsed.edition;
    const key = `standalone:${libraryId}:${slug(parsed.name)}:${parsed.year ?? ""}:${slug(edition ?? "")}`;
    const group = groups.get(key) ?? { key, name: parsed.name, year: parsed.year, edition: edition ?? null, tmdbId: parsed.tmdbId, imdbId: parsed.imdbId, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  let added = 0;
  for (const group of groups.values()) {
    const result = await syncMovieGroup(provider, libraryId, group, { listing: entries, variants, sideFiles: true });
    if (result.added) added++;
  }
  return added;
}

async function enrichMovieMetadataIfNeeded(
  titleId: string,
  name: string,
  year: number | null,
  tag: FolderIdTags = { tmdbId: null, imdbId: null }
) {
  const [current] = await db
    .select({ metadataStatus: titles.metadataStatus, tmdbId: titles.tmdbId, imdbId: titles.imdbId })
    .from(titles)
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!current) return;
  // An id tag in the folder name overrides whatever is matched now (even a
  // manual or earlier auto match); without one only pending titles match.
  const forcedId = await resolveForcedTmdbId("movie", tag, current);
  const rematch = forcedId !== null && forcedId !== current.tmdbId;
  if (current.metadataStatus !== "pending" && !rematch) return;

  try {
    // An id tag lets us skip fuzzy search entirely; fall back to search
    // if the tagged id turns out to be stale/wrong (only for a pending title —
    // a rematch of an already-matched one just leaves it alone).
    const wantedId = forcedId ?? tag.tmdbId;
    let details = wantedId ? await getMovieDetails(wantedId, { append: ["release_dates"] }).catch(() => null) : null;
    if (!details && current.metadataStatus !== "pending") return;
    let matchedId = wantedId;
    if (!details) {
      const match = await searchMovie(name, year);
      if (!match) {
        await db
          .update(titles)
          .set({ metadataStatus: "not_found" })
          .where(eq(titles.id, titleId));
        return;
      }
      matchedId = match.id;
      details = await getMovieDetails(matchedId, { append: ["release_dates"] });
    }
    const { certifications, ratingAges } = ratingsFromMovieDetails(details);
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "matched",
        certifications,
        ratingAges,
        ratingsAttemptedAt: new Date(),
        imdbId: details.imdb_id ?? null,
        ...collectionColumnsOnMatch(details),
        ...((details.imdb_id ?? null) !== current.imdbId ? STALE_EXTERNAL_RATINGS : {}),
      })
      .where(eq(titles.id, titleId));
  } catch {
    // Leave as pending; a later rescan (or admin manual match) retries this.
  }
}

// ── Shows ────────────────────────────────────────────────────────────────

/** Reads a folder's ".plexmatch" (Plex's match hints), if it has one. */
async function readPlexMatch(provider: Pick<StorageProvider, "fetchByteRange">, children: StorageEntry[]): Promise<PlexMatch> {
  const file = children.find((c) => c.kind === "file" && c.name.toLowerCase() === ".plexmatch");
  if (!file) return emptyPlexMatch();
  try {
    const size = Math.min(file.sizeBytes ?? 65_536, 65_536);
    if (size <= 0) return emptyPlexMatch();
    return parsePlexMatch(decodeSubtitleBytes(new Uint8Array(await provider.fetchByteRange(file.id, 0, size - 1))));
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) throw err;
    return emptyPlexMatch();
  }
}

/** Where a season's files are read from: its folder, or the show folder itself for episodes kept loose in it. */
interface SeasonSource {
  number: number;
  /** seasons.boxFolderId: the season folder's id, or a name made from the show folder's for loose episodes. */
  key: string;
  /** What episodes record as their folder. */
  folderId: string;
  children: StorageEntry[];
  hints: PlexMatch;
  /** Hints from the show folder's .plexmatch that reach the files here, by path from the show folder. */
  prefix: string;
}

export async function syncShowFolder(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry,
  skipped?: (n: number) => void
): Promise<boolean> {
  const rootChildren = await provider.listFolder(folder.id);
  // A .plexmatch in the show folder can name the series (title, year, ids) when the folder's own name is no help.
  const showHints = await readPlexMatch(provider, rootChildren);
  const parsedFolder = parseTitleFolderName(folder.name);
  const name = showHints.title ?? parsedFolder.name;
  const year = showHints.year ?? parsedFolder.year;
  const tmdbId = showHints.tmdbId ?? parsedFolder.tmdbId;
  const imdbId = showHints.imdbId ?? parsedFolder.imdbId;
  const tvdbId = showHints.tvdbId ?? parsedFolder.tvdbId;

  const [existing] = await db
    .select({ id: titles.id })
    .from(titles)
    .where(eq(titles.boxFolderId, folder.id))
    .limit(1);

  const [title] = await db
    .insert(titles)
    .values({ libraryId, kind: "show", name, year, boxFolderId: folder.id })
    .onConflictDoUpdate({
      target: titles.boxFolderId,
      set: { name, year, updatedAt: new Date() },
    })
    .returning();

  let tmdbShowId: number | null = null;
  // An id tag pins the show even after it was matched (see the movie path). A TheTVDB id is looked up once, while the show has no match.
  let forcedId = await resolveForcedTmdbId("show", { tmdbId, imdbId }, title);
  if (forcedId === null && tvdbId && !title.tmdbId) forcedId = await findTmdbShowIdByTvdbId(tvdbId).catch(() => null);
  const rematch = !!existing && forcedId !== null && forcedId !== title.tmdbId;
  if (!existing || rematch || (forcedId !== null && !title.tmdbId)) {
    // A folder id tag lets us skip fuzzy search entirely; fall
    // back to search if the tagged id turns out to be stale/wrong.
    const wantedId = forcedId ?? tmdbId;
    let details = wantedId ? await getTvShowDetails(wantedId, { append: ["content_ratings", "external_ids"] }).catch(() => null) : null;
    if (details) tmdbShowId = wantedId;
    if (!details && !rematch) {
      const match = await searchTvShow(name, year).catch(() => null);
      if (match) {
        details = await getTvShowDetails(match.id, { append: ["content_ratings", "external_ids"] }).catch(() => null);
        tmdbShowId = match.id;
      }
    }
    if (details) {
      const { certifications, ratingAges } = ratingsFromTvDetails(details);
      await db
        .update(titles)
        .set({
          tmdbId: details.id,
          overview: details.overview ?? null,
          posterUrl: tmdbImageUrl(details.poster_path, "w500"),
          backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
          genres: details.genres?.map((g) => g.name) ?? [],
          metadataStatus: "matched",
          certifications,
          ratingAges,
          ratingsAttemptedAt: new Date(),
          imdbId: details.external_ids?.imdb_id ?? null,
          ...((details.external_ids?.imdb_id ?? null) !== title.imdbId ? STALE_EXTERNAL_RATINGS : {}),
        })
        .where(eq(titles.id, title.id));
    } else if (!rematch) {
      await db
        .update(titles)
        .set({ metadataStatus: "not_found" })
        .where(eq(titles.id, title.id));
    }
  }
  if (tmdbShowId === null) tmdbShowId = title.tmdbId;

  // Where the seasons are: season folders (Season 01, Season 1, S01, Specials), and episodes kept loose in the show folder, which Plex numbers by
  // their names (and a .plexmatch can number any file at all).
  const sources = new Map<number, SeasonSource>();
  for (const seasonFolder of rootChildren.filter((e) => e.kind === "folder")) {
    const children = await provider.listFolder(seasonFolder.id);
    const hints = await readPlexMatch(provider, children);
    const number = hints.season ?? parseSeasonFolderName(seasonFolder.name);
    if (number === null) continue;
    const had = sources.get(number);
    if (had) had.children = [...had.children, ...children];
    else sources.set(number, { number, key: seasonFolder.id, folderId: seasonFolder.id, children, hints, prefix: `${seasonFolder.name}/` });
  }
  const looseVideo = rootChildren.filter((c) => c.kind === "file" && isVideoFile(c.name) && !isExtraFile(c.name));
  if (looseVideo.length > 0) {
    const loose = new Map<number, StorageEntry[]>();
    for (const file of looseVideo) {
      const hinted = hintForFile(showHints, file.name);
      const season = hinted?.season ?? parseEpisodeFileName(file.name)?.season ?? (hinted || showHints.season !== null ? showHints.season ?? 1 : null);
      if (season === null) continue;
      loose.set(season, [...(loose.get(season) ?? []), file]);
    }
    for (const [number, files] of loose) {
      const had = sources.get(number);
      if (had) had.children = [...had.children, ...files];
      else sources.set(number, { number, key: `${folder.id}#s${number}`, folderId: folder.id, children: [...files, ...rootChildren.filter((c) => c.kind === "file" && !isVideoFile(c.name))], hints: emptyPlexMatch(), prefix: "" });
    }
  }
  skipped?.([...sources.values()].reduce((n, s) => n + s.children.filter((c) => c.kind === "file" && isUnplayableVideo(c.name)).length, 0) + rootChildren.filter((c) => c.kind === "file" && isUnplayableVideo(c.name)).length);

  for (const src of [...sources.values()].sort((a, b) => a.number - b.number)) {
    const seasonNumber = src.number;
    const [season] = await db
      .insert(seasons)
      .values({ titleId: title.id, number: seasonNumber, boxFolderId: src.key })
      .onConflictDoUpdate({
        target: seasons.boxFolderId,
        set: { number: seasonNumber },
      })
      .returning();

    const tmdbEpisodes = tmdbShowId
      ? await getSeasonEpisodes(tmdbShowId, seasonNumber).catch(() => [])
      : [];

    const seasonChildren = src.children;
    const seasonVideo = seasonChildren.filter(
      (e) => e.kind === "file" && isVideoFile(e.name) && !isExtraFile(e.name)
    );
    // Remuxed audio variants are split out before any episode grouping.
    const episodeFiles = seasonVideo.filter((e) => !isBrowserFriendlyVariant(e.name));
    const variantFiles = seasonVideo.filter((e) => isBrowserFriendlyVariant(e.name));

    // The season's real episode numbers, when TMDB has matched — narrows a
    // multi-episode file's claimed span down to what actually exists (see
    // clampEpisodesToKnown), rather than trusting the filename's own
    // number unconditionally. Null (not an empty set) when there's no
    // TMDB data yet, so groupEpisodeFiles knows to leave the span
    // untouched instead of treating "nothing confirmed" as "confirmed
    // nothing" — this self-corrects on a later scan once a match lands.
    const knownEpisodeNumbers =
      tmdbEpisodes.length > 0 ? new Set(tmdbEpisodes.map((e) => e.episode_number)) : null;

    // Files numbered by something other than an sXXeYY in the name: a .plexmatch hint (this folder's, or the show folder's by path), or, for a
    // date-named file ("Show - 2011-11-15 - Guest.mp4"), the episode TMDB says aired that day.
    const byAirDate = new Map(tmdbEpisodes.filter((e) => e.air_date).map((e) => [e.air_date as string, e]));
    const numberedOtherwise = (file: StorageEntry) => {
      const hinted = hintForFile(src.hints, file.name) ?? (src.prefix ? hintForFile(showHints, `${src.prefix}${file.name}`) : hintForFile(showHints, file.name));
      if (hinted && hinted.episodes.length > 0) {
        const first = hinted.episodes[0];
        const own = parseEpisodeFileName(file.name);
        return { season: hinted.season ?? seasonNumber, episode: first, episodes: hinted.episodes, name: own?.name ?? null, version: own?.version ?? "" };
      }
      if (parseEpisodeFileName(file.name)) return null;
      const aired = parseEpisodeAirDate(file.name);
      const ep = aired ? byAirDate.get(aired) : undefined;
      return ep ? { season: seasonNumber, episode: ep.episode_number, episodes: [ep.episode_number], name: null, version: splitVersionLabel(file.name).label } : null;
    };

    // Group files by episode number first (mirroring how a movie's segments
    // are grouped) rather than upserting per-file. Processing one file at a
    // time here would (a) let a second part's upsert delete the first
    // part's media_files row, since each call would see only itself as
    // "current", and (b) never detect a removed/renamed episode file, since
    // a missing file just never appears in the loop at all. A multi-episode
    // file ("S01E05-E06") attaches to every episode number it spans — see
    // groupEpisodeFiles.
    const episodeGroups = groupEpisodeFiles(episodeFiles, knownEpisodeNumbers, numberedOtherwise);

    const currentEpisodeRows: { id: string }[] = [];

    for (const [episodeNumber, { files, combined }] of episodeGroups) {
      const orderedFiles = [...groupByVersion(files).values()].flatMap((group) => orderMediaSegments(group));
      const parsed = numberedOtherwise(orderedFiles[0]) ?? parseEpisodeFileName(orderedFiles[0].name);
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === episodeNumber);
      // A combined file's title describes the whole block, not one episode:
      // prefer TMDB's per-episode name, falling back to the file's own title
      // only for the episode number the file's title text is actually
      // attached to (its first episode).
      const name = combined
        ? tmdbEp?.name ?? (parsed?.episode === episodeNumber ? parsed.name : null)
        : parsed?.name ?? tmdbEp?.name ?? null;

      const [episode] = await db
        .insert(episodes)
        .values({
          seasonId: season.id,
          number: episodeNumber,
          name,
          boxFolderId: src.folderId,
          tmdbId: tmdbEp?.id ?? null,
          overview: tmdbEp?.overview ?? null,
          stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
          runtimeSeconds: tmdbEp?.runtime ? tmdbEp.runtime * 60 : null,
        })
        .onConflictDoUpdate({
          target: [episodes.seasonId, episodes.number],
          set: {
            name,
            tmdbId: tmdbEp?.id ?? null,
            overview: tmdbEp?.overview ?? null,
            stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
            // Insert-only before this: a TMDB miss on the first scan (show not
            // yet matched, or a per-season lookup failure) was permanent. The
            // split pass needs runtime to arrive on a later rescan, so a real
            // value now overwrites a stale one — but a miss this pass keeps
            // whatever runtime is already stored rather than nulling it out.
            runtimeSeconds: tmdbEp?.runtime ? tmdbEp.runtime * 60 : sql`${episodes.runtimeSeconds}`,
          },
        })
        .returning();

      currentEpisodeRows.push({ id: episode.id });
      await upsertMediaSegments("episode", episode.id, orderedFiles);
    }

    // Remove episodes whose files are no longer present in this season's
    // Box folder, and their now-orphaned media_files rows.
    const currentEpisodeIds = currentEpisodeRows.map((e) => e.id);
    const staleEpisodes = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        currentEpisodeIds.length > 0
          ? and(eq(episodes.seasonId, season.id), notInArray(episodes.id, currentEpisodeIds))
          : eq(episodes.seasonId, season.id)
      );
    if (staleEpisodes.length > 0) {
      const staleIds = staleEpisodes.map((e) => e.id);
      await db
        .delete(mediaFiles)
        .where(and(eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, staleIds)));
      await db.delete(episodes).where(inArray(episodes.id, staleIds));
    }

    // After stale-episode deletion (which cascades away a deleted episode's
    // variant links), so linking sees the season's final primary rows.
    await linkVariantFiles("episode", currentEpisodeIds, episodeFiles, variantFiles);
    // Chapter files beside the episodes ("Show - S01E01.chapters.txt").
    await syncChapterFiles(provider, seasonChildren).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`chapter files for season ${season.id}:`, err);
    });
    await syncContentFilterFiles(provider, seasonChildren).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`content filter files for season ${season.id}:`, err);
    });
    const withSubs = await withSubtitleFolders(provider, seasonChildren);
    await syncSubtitleFiles(provider, withSubs).catch((err) => {
      if (err instanceof StorageReauthRequiredError) throw err;
      console.error(`subtitle files for season ${season.id}:`, err);
    });
    await syncSidecarTracks(db, withSubs).catch((err) => console.error(`subtitle tracks for season ${season.id}:`, err));
  }

  // A poster in the show folder ("poster.jpg", "folder.jpg", "show.jpg") wins over the one TMDB gave.
  await syncLocalPoster(provider, title.id, posterFile(rootChildren, SHOW_POSTER_NAMES));

  // The show's trailers, featurettes and the like: in folders named for the type in the show folder or a season folder, or beside an episode
  // with a type suffix ("Show - S01E01 - Title-deleted1.mkv"). They are the show's, whichever of those they sit in.
  try {
    const found: FoundExtra[] = [];
    let complete = true;
    for (const listing of [rootChildren, ...[...sources.values()].filter((s) => s.folderId !== folder.id).map((s) => s.children)]) {
      const r = await findExtras(provider, listing);
      found.push(...r.found);
      complete = complete && r.complete;
    }
    await syncTitleExtras(title.id, [...new Map(found.map((f) => [f.entry.id, f])).values()], complete);
  } catch (err) {
    console.error(`extras for ${title.id}:`, err);
  }

  return !existing;
}

/**
 * Re-fetches episode metadata (name fallback, overview, still, tmdbId,
 * runtime) for a show's EXISTING seasons/episodes from a given TMDB show
 * id — no Box calls, so it's cheap enough to run right after an admin picks
 * a corrected TMDB match. Does not add/remove episodes (that only happens
 * via a real folder scan); it only refreshes metadata on rows that already
 * exist.
 */
export async function refreshShowEpisodesFromTmdb(showId: string, tmdbShowId: number) {
  const showSeasons = await db.select().from(seasons).where(eq(seasons.titleId, showId));
  const allEpisodeIds: string[] = [];

  for (const season of showSeasons) {
    const tmdbEpisodes = await getSeasonEpisodes(tmdbShowId, season.number).catch(() => []);
    if (tmdbEpisodes.length === 0) continue;

    const existingEpisodes = await db
      .select()
      .from(episodes)
      .where(eq(episodes.seasonId, season.id));

    for (const ep of existingEpisodes) {
      allEpisodeIds.push(ep.id);
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === ep.number);
      if (!tmdbEp) continue;
      await db
        .update(episodes)
        .set({
          name: ep.name ?? tmdbEp.name ?? null,
          tmdbId: tmdbEp.id,
          overview: tmdbEp.overview ?? null,
          stillUrl: tmdbImageUrl(tmdbEp.still_path, "w500"),
          runtimeSeconds: tmdbEp.runtime ? tmdbEp.runtime * 60 : ep.runtimeSeconds,
        })
        .where(eq(episodes.id, ep.id));
    }
  }

  // A manual TMDB rematch is exactly when a combined file's estimated
  // split can most improve — this show may have just gained real runtimes
  // for the first time.
  await resolveEpisodeSplits(allEpisodeIds);
}

// ── Duration probing ─────────────────────────────────────────────────────

/**
 * Expands a library to every title/episode id under it — the unit that
 * media_files rows are actually owned by (ownerKind/ownerId). Shared by
 * the library-wide prober and the admin status endpoint (which reports
 * live probe-completion counts for the progress indicator).
 */
export async function resolveLibraryOwnerIds(
  libraryId: string
): Promise<{ titleIds: string[]; episodeIds: string[] }> {
  const libraryTitles = await db
    .select({ id: titles.id })
    .from(titles)
    .where(eq(titles.libraryId, libraryId));
  const titleIds = libraryTitles.map((t) => t.id);

  const librarySeasons = titleIds.length
    ? await db.select({ id: seasons.id }).from(seasons).where(inArray(seasons.titleId, titleIds))
    : [];
  const seasonIds = librarySeasons.map((s) => s.id);

  const libraryEpisodes = seasonIds.length
    ? await db.select({ id: episodes.id }).from(episodes).where(inArray(episodes.seasonId, seasonIds))
    : [];
  const episodeIds = libraryEpisodes.map((e) => e.id);

  return { titleIds, episodeIds };
}

/**
 * Scoped to THIS library only — not every pending media_file in the whole
 * database. Before multi-tenancy this was harmless (only one library ever
 * existed); now, an unscoped query here would try to probe another
 * server's files using the current server's Box connection, which would
 * simply fail (wrong Box account), pollute this scan's errors with
 * irrelevant failures, and never actually get the other server's files
 * probed (since a scan only ever passes the CURRENT library's provider).
 */
async function probePendingDurations(
  provider: StorageProvider,
  libraryId: string,
  deadline: number,
  errors: string[],
  audibleRegion: string | null = null
): Promise<boolean> {
  const { titleIds, episodeIds } = await resolveLibraryOwnerIds(libraryId);

  // A movie's extras are probed like any video, so they can be played.
  const extraIds = titleIds.length
    ? (await db.select({ id: titleExtras.id }).from(titleExtras).where(inArray(titleExtras.titleId, titleIds))).map((e) => e.id)
    : [];
  const [pendingTitleFiles, pendingEpisodeFiles, pendingVariantFiles, pendingExtraFiles] = await Promise.all([
    titleIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(
            and(
              pendingProbeCondition,
              eq(mediaFiles.ownerKind, "title"),
              inArray(mediaFiles.ownerId, titleIds)
            )
          )
      : Promise.resolve([]),
    episodeIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(
            and(
              pendingProbeCondition,
              eq(mediaFiles.ownerKind, "episode"),
              inArray(mediaFiles.ownerId, episodeIds)
            )
          )
      : Promise.resolve([]),
    // Remuxed variants (no owner of their own) — scoped via their primaries.
    // Audiobooks never have variants, so title-scope matches nothing there.
    Promise.all([
      titleIds.length
        ? db.select().from(mediaFiles).where(and(pendingProbeCondition, variantScope("title", titleIds)))
        : [],
      episodeIds.length
        ? db.select().from(mediaFiles).where(and(pendingProbeCondition, variantScope("episode", episodeIds)))
        : [],
    ]).then(([a, b]) => [...a, ...b]),
    extraIds.length
      ? db.select().from(mediaFiles).where(and(pendingProbeCondition, eq(mediaFiles.ownerKind, "extra"), inArray(mediaFiles.ownerId, extraIds)))
      : Promise.resolve([]),
  ]);
  const pending = [...pendingTitleFiles, ...pendingEpisodeFiles, ...pendingVariantFiles, ...pendingExtraFiles];
  const incomplete = await probeFiles(provider, pending, deadline, errors);

  await backfillCodecs(provider, titleIds, episodeIds, deadline);
  await backfillChapters(provider, titleIds, episodeIds, deadline);

  // A newly-probed duration (or a runtime that just arrived via TMDB) is
  // exactly what a combined episode file's split needs to go from "whole"
  // to a real estimate — recompute after every probe pass, not just once.
  if (episodeIds.length > 0) await resolveEpisodeSplits(episodeIds);

  // Roll up movie runtimes from their segments' probed durations — this
  // library's movies only.
  const movieTitles = titleIds.length
    ? await db
        .select({ id: titles.id })
        .from(titles)
        .where(and(inArray(titles.id, titleIds), inArray(titles.kind, ["movie", "audiobook"])))
    : [];
  for (const t of movieTitles) {
    await rollupTitleRuntime(t.id);
  }

  // Audiobook chapters can be built once a book's parts are all probed.
  if (audibleRegion) await resolvePendingAudiobookChapters(libraryId, audibleRegion, deadline);

  return incomplete;
}

const SINGLE_TITLE_TIME_BUDGET_MS = 40_000;

/**
 * One-time codec backfill for rows whose duration was probed before codec
 * detection existed (or whose inline codec read failed). Gets only a third of
 * the time left before `deadline`, so it can never crowd out core probing;
 * leftovers just continue on the next pass. Audiobooks are excluded (their
 * containers/codecs are never a candidate for the audio fix).
 */
async function backfillCodecs(
  provider: StorageProvider,
  titleIds: string[],
  episodeIds: string[],
  deadline: number
) {
  const now = Date.now();
  if (deadline <= now) return;
  const codecDeadline = now + (deadline - now) / 3;

  const movieIds = titleIds.length
    ? (
        await db
          .select({ id: titles.id })
          .from(titles)
          .where(and(inArray(titles.id, titleIds), eq(titles.kind, "movie")))
      ).map((t) => t.id)
    : [];

  const [movieFiles, episodeFiles] = await Promise.all([
    movieIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(
            and(pendingCodecProbeCondition, eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, movieIds))
          )
      : Promise.resolve([]),
    episodeIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(
            and(
              pendingCodecProbeCondition,
              eq(mediaFiles.ownerKind, "episode"),
              inArray(mediaFiles.ownerId, episodeIds)
            )
          )
      : Promise.resolve([]),
  ]);
  await probeCodecsForPending(provider, [...movieFiles, ...episodeFiles], codecDeadline);
}

/**
 * One-time chapter read for movies and episodes probed before chapters were read for them. A slice of the time left, like the codec
 * backfill, so it never crowds out core probing; leftovers continue on the next pass.
 */
async function backfillChapters(provider: StorageProvider, titleIds: string[], episodeIds: string[], deadline: number) {
  const now = Date.now();
  if (deadline <= now) return;
  const chapterDeadline = now + (deadline - now) / 3;
  const movieIds = titleIds.length
    ? (await db.select({ id: titles.id }).from(titles).where(and(inArray(titles.id, titleIds), eq(titles.kind, "movie")))).map((t) => t.id)
    : [];
  const [movieFiles, episodeFiles] = await Promise.all([
    movieIds.length ? db.select().from(mediaFiles).where(and(pendingChapterReadCondition, eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, movieIds))) : Promise.resolve([]),
    episodeIds.length ? db.select().from(mediaFiles).where(and(pendingChapterReadCondition, eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, episodeIds))) : Promise.resolve([]),
  ]);
  await readChaptersForPending(provider, [...movieFiles, ...episodeFiles], chapterDeadline);
}

/**
 * Resyncs one title's Box folder — for when a file was added/fixed on just
 * this one title and rescanning the whole (possibly huge) library isn't
 * worth the wait. Re-lists the folder's current contents (picking up
 * added/removed/renamed files and any {tmdb-...}/{edition-...} tag
 * changes via a fresh Box lookup of the folder's own name) and probes any
 * of its files still pending.
 */
export async function syncSingleTitle(titleId: string): Promise<{ errors: string[] }> {
  const startedAt = Date.now();
  const [title] = await db.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title) throw new Error(`Title ${titleId} not found`);
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, title.libraryId))
    .limit(1);
  if (!library) throw new Error(`Library ${title.libraryId} not found`);
  // Resync re-lists the title's Box FOLDER and matches it against outside services. A file-tree library's
  // titles are single files with a file key, so none of that applies (and any kind not named as
  // externally matched is refused, not just the ones we know about).
  if (!libraryKindUsesExternalMetadata(library.kind)) {
    return { errors: ["Resync isn't available for items in this kind of library."] };
  }

  const provider = createStorageForServer(library.serverId);
  const errors: string[] = [];

  try {
    const folderInfo = await provider.getFolder(title.boxFolderId);
    if (!folderInfo) {
      errors.push("This title's folder no longer exists in Box — it may have been moved or deleted.");
      return { errors };
    }

    switch (title.kind) {
      case "movie":
        await syncMovieFolder(provider, library.id, folderInfo);
        break;
      case "show":
        await syncShowFolder(provider, library.id, folderInfo);
        break;
      case "audiobook":
        await syncSingleAudiobook(provider, library.id, folderInfo);
        break;
      case "photo":
      case "ebook":
        // Photos and books live in file-tree libraries, which are refused above; nothing to resync by folder.
        break;
      default:
        assertNever(title.kind);
    }

    const deadline = startedAt + SINGLE_TITLE_TIME_BUDGET_MS;
    await probeTitlePendingDurations(provider, titleId, title.kind, deadline, errors);

    if (title.kind === "audiobook") {
      await resolveAudiobookChaptersWhenProbed(titleId, library.audibleRegion);
    } else if (title.tmdbId) {
      // An explicit resync retries even a title OMDb previously had nothing for.
      await db.update(titles).set({ externalRatingsAttemptedAt: null }).where(eq(titles.id, titleId));
      // An explicit resync also asks TMDB again (the shared entry, so every server's copy of this title gets it).
      await refreshEntry(title.kind === "show" ? "tv" : "movie", title.tmdbId);
      await backfillExternalRatings(library.id, deadline, titleId);
    }
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) {
      errors.push("This server's Box connection needs to be reconnected by an admin.");
    } else {
      errors.push((err as Error).message);
    }
  }

  return { errors };
}

/** Builds an audiobook's chapters if it has none yet and none of its parts are still awaiting a probe. */
async function resolveAudiobookChaptersWhenProbed(titleId: string, region: string) {
  const [title] = await db.select({ chapters: titles.chapters }).from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title || title.chapters !== null) return;
  const [stillProbing] = await db
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId), pendingProbeCondition))
    .limit(1);
  if (stillProbing) return;
  await resolveAudiobookChapters(titleId, region);
}

async function probeTitlePendingDurations(
  provider: StorageProvider,
  titleId: string,
  kind: TitleKind,
  deadline: number,
  errors: string[]
) {
  let pending: (typeof mediaFiles.$inferSelect)[];
  // Movies and audiobooks own their files directly; shows own them via episodes.
  const titleOwned = kind === "movie" || kind === "audiobook";
  let episodeIds: string[] = [];
  if (titleOwned) {
    pending = await db
      .select()
      .from(mediaFiles)
      .where(
        and(
          pendingProbeCondition,
          eq(mediaFiles.ownerKind, "title"),
          eq(mediaFiles.ownerId, titleId)
        )
      );
  } else {
    const titleSeasons = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.titleId, titleId));
    const seasonIds = titleSeasons.map((s) => s.id);
    const titleEpisodes = seasonIds.length
      ? await db.select({ id: episodes.id }).from(episodes).where(inArray(episodes.seasonId, seasonIds))
      : [];
    episodeIds = titleEpisodes.map((e) => e.id);
    pending = episodeIds.length
      ? await db
          .select()
          .from(mediaFiles)
          .where(
            and(
              pendingProbeCondition,
              eq(mediaFiles.ownerKind, "episode"),
              inArray(mediaFiles.ownerId, episodeIds)
            )
          )
      : [];
  }

  const ownerIdsForVariants = titleOwned ? [titleId] : episodeIds;
  if (kind !== "audiobook" && ownerIdsForVariants.length > 0) {
    const variants = await db
      .select()
      .from(mediaFiles)
      .where(and(pendingProbeCondition, variantScope(titleOwned ? "title" : "episode", ownerIdsForVariants)));
    pending = [...pending, ...variants];
  }
  if (kind === "movie") {
    const extraIds = (await db.select({ id: titleExtras.id }).from(titleExtras).where(eq(titleExtras.titleId, titleId))).map((e) => e.id);
    if (extraIds.length > 0) {
      pending = [...pending, ...(await db.select().from(mediaFiles).where(and(pendingProbeCondition, eq(mediaFiles.ownerKind, "extra"), inArray(mediaFiles.ownerId, extraIds))))];
    }
  }

  await probeFiles(provider, pending, deadline, errors);
  if (kind !== "audiobook") await backfillCodecs(provider, titleOwned ? [titleId] : [], episodeIds, deadline);
  if (kind === "movie" || episodeIds.length > 0) await backfillChapters(provider, titleOwned ? [titleId] : [], episodeIds, deadline);
  if (titleOwned) await rollupTitleRuntime(titleId);
  else if (episodeIds.length > 0) await resolveEpisodeSplits(episodeIds);
}
