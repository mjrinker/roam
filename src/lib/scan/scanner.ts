import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
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
  titles,
  type TitleKind,
} from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  groupEpisodeFiles,
  isBrowserFriendlyVariant,
  isExtraFile,
  isVideoFile,
  orderMediaSegments,
  parseEditionTag,
  parseEpisodeFileName,
  parseSeasonFolderName,
  parseTitleFolderName,
} from "@/lib/scan/conventions";
import {
  enrichPendingAudiobooks,
  resolveAudiobookChapters,
  resolvePendingAudiobookChapters,
  syncAudiobookTopFolder,
  syncSingleAudiobook,
} from "@/lib/scan/audiobooks";
import { resolveEpisodeSplits } from "@/lib/scan/episode-split-pass";
import {
  linkVariantFiles,
  pendingCodecProbeCondition,
  pendingProbeCondition,
  probeCodecsForPending,
  probeFiles,
  rollupTitleRuntime,
  upsertMediaSegments,
  variantScope,
} from "@/lib/scan/media-files";
import {
  getMovieDetails,
  getSeasonEpisodes,
  getTvShowDetails,
  searchMovie,
  searchTvShow,
  tmdbImageUrl,
} from "@/lib/tmdb/client";
import { ratingsFromMovieDetails, ratingsFromTvDetails } from "@/lib/content/ratings";
import { backfillRatings } from "@/lib/content/ratings-backfill";
import { backfillExternalRatings } from "@/lib/content/external-ratings-backfill";

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
  let incomplete = false;
  // Set when another scan takes over the cursor mid-pass; this pass then
  // stops without touching the library's scan state.
  let superseded = false;
  const errors: string[] = [];
  const provider = createBoxProviderForServer(library.serverId);

  const plan = planScan(trigger, library);
  let cursor: ScanCursor | null = plan.mode === "continue" ? plan.cursor : null;

  try {
    if (plan.mode === "full") {
      // A fresh cycle: unconditional reset, so any in-flight chained pass
      // fails its next compare-and-set and stops rather than fighting us.
      await db
        .update(libraries)
        .set({ scanCursor: null, scanFoldersTotal: 0, scanFoldersDone: 0 })
        .where(eq(libraries.id, libraryId));
    }

    if (plan.mode !== "probe-only") {
      const topLevel = await provider.listFolder(library.boxFolderId);
      const sortedFolders = sortForScan(topLevel.filter((e) => e.kind === "folder"));
      const titleFolders = entriesAfterCursor(sortedFolders, cursor);
      if (plan.mode === "full") {
        await db
          .update(libraries)
          .set({ scanFoldersTotal: sortedFolders.length })
          .where(eq(libraries.id, libraryId));
      }

      let processed = 0;
      let loopFinished = true;
      for (const folder of titleFolders) {
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
              const added = await syncMovieFolder(provider, library.id, folder);
              if (added) titlesAdded++;
              filesSeen += 1;
              break;
            }
            case "shows": {
              const added = await syncShowFolder(provider, library.id, folder);
              if (added) titlesAdded++;
              break;
            }
            case "audiobooks": {
              const res = await syncAudiobookTopFolder(provider, library.id, folder, {
                afterSub: cursor?.folder === folder.name ? (cursor.sub ?? null) : null,
                errors,
                budgetExhausted: () => processed > 0 && Date.now() - startedAt > FOLDER_SYNC_TIME_BUDGET_MS,
                onUnitDone: async (childName) => {
                  const next: ScanCursor = { folder: folder.name, sub: childName };
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
            default:
              assertNever(library.kind);
          }
        } catch (err) {
          // A single title's own Box connection dying mid-scan means every
          // OTHER title will fail the same way — short-circuit with one
          // clear error instead of one near-identical message per folder.
          if (err instanceof BoxReauthRequiredError) throw err;
          errors.push(`${folder.name}: ${(err as Error).message}`);
        }
        if (stopLoop) break;
        processed++;

        // Advance even after a per-folder error, so one bad folder can't
        // stall the whole cycle.
        const next: ScanCursor = { folder: folder.name };
        if (!(await advanceScanCursor(libraryId, cursor, next))) {
          superseded = true;
          break;
        }
        cursor = next;
      }

      // Folder loop reached the end: clear the cursor. Folder sync is done
      // for this cycle; any remaining work is probing.
      if (loopFinished && !superseded && !(await advanceScanCursor(libraryId, cursor, null))) {
        superseded = true;
      }
    }

    if (!superseded) {
      const probeDeadline = startedAt + SCAN_TIME_BUDGET_MS;
      // Capped so these lookups can't starve probing of the whole pass.
      const enrichDeadline = Math.min(probeDeadline, Date.now() + ENRICH_TIME_BUDGET_MS);
      if (library.kind === "audiobooks") {
        const moreToMatch = await enrichPendingAudiobooks(library.id, library.audibleRegion, enrichDeadline);
        incomplete = incomplete || moreToMatch;
      } else {
        const moreRatings = await backfillRatings(library.id, enrichDeadline);
        const moreExternalRatings = await backfillExternalRatings(library.id, enrichDeadline);
        incomplete = incomplete || moreRatings || moreExternalRatings;
      }
      const audibleRegion = library.kind === "audiobooks" ? library.audibleRegion : null;
      const probeIncomplete = await probePendingDurations(provider, library.id, probeDeadline, errors, audibleRegion);
      incomplete = incomplete || probeIncomplete;
    }
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
      errors.push("This server's Box connection needs to be reconnected by an admin.");
    } else {
      errors.push((err as Error).message);
    }
  }

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
 * Compare-and-set on libraries.scan_cursor: moves it from `from` to `to`
 * only if it still holds `from`. False means another scan advanced or reset
 * it since this pass read it, so this pass no longer owns the cursor.
 */
async function advanceScanCursor(
  libraryId: string,
  from: ScanCursor | null,
  to: ScanCursor | null
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
        sql`${libraries.scanCursor} IS NOT DISTINCT FROM ${fromJson}::jsonb`
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

// ── Movies ───────────────────────────────────────────────────────────────

async function syncMovieFolder(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry
): Promise<boolean> {
  const { name, year, tmdbId, edition } = parseTitleFolderName(folder.name);
  // Plex's directory-level {edition-...} convention gives each edition its
  // own folder, which already becomes its own separate title here — fold
  // the edition into the display name so two same-named titles are still
  // distinguishable in the UI.
  const displayName = edition ? `${name} (${edition})` : name;

  const [existing] = await db
    .select({ id: titles.id })
    .from(titles)
    .where(eq(titles.boxFolderId, folder.id))
    .limit(1);

  const [title] = await db
    .insert(titles)
    .values({
      libraryId,
      kind: "movie",
      name: displayName,
      year,
      boxFolderId: folder.id,
    })
    .onConflictDoUpdate({
      target: titles.boxFolderId,
      set: { name: displayName, year, updatedAt: new Date() },
    })
    .returning();

  const children = await provider.listFolder(folder.id);
  const allVideo = children.filter((c) => c.kind === "file" && isVideoFile(c.name) && !isExtraFile(c.name));
  // Remuxed audio variants must be split out BEFORE any segment/edition
  // logic, or they'd be appended to the movie as extra parts.
  const candidateFiles = allVideo.filter((c) => !isBrowserFriendlyVariant(c.name));
  const variantFiles = allVideo.filter((c) => isBrowserFriendlyVariant(c.name));
  const videoFiles = orderMediaSegments(selectPrimaryEdition(candidateFiles));

  await upsertMediaSegments("title", title.id, videoFiles);
  await linkVariantFiles("title", [title.id], videoFiles, variantFiles);
  await enrichMovieMetadataIfNeeded(title.id, name, year, tmdbId);

  return !existing;
}

/**
 * Plex allows multiple full-length editions of a movie to sit in one
 * folder, each file tagged with a file-level {edition-...} suffix. Roam
 * has no concept of alternate versions of a title — only ordered SEGMENTS
 * of one continuous playback — so naively treating every file as a segment
 * would concatenate two unrelated cuts of the movie back-to-back. Pick one
 * edition's files (the untagged/default group if one exists, otherwise the
 * alphabetically-first tagged edition) and ignore the rest.
 */
function selectPrimaryEdition(files: StorageEntry[]): StorageEntry[] {
  const groups = new Map<string, StorageEntry[]>();
  for (const file of files) {
    const edition = parseEditionTag(file.name) ?? "";
    const list = groups.get(edition) ?? [];
    list.push(file);
    groups.set(edition, list);
  }
  if (groups.size <= 1) return files;
  const defaultGroup = groups.get("");
  if (defaultGroup) return defaultGroup;
  const firstKey = [...groups.keys()].sort()[0];
  return groups.get(firstKey)!;
}

async function enrichMovieMetadataIfNeeded(
  titleId: string,
  name: string,
  year: number | null,
  tmdbId: number | null = null
) {
  const [current] = await db
    .select({ metadataStatus: titles.metadataStatus })
    .from(titles)
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!current || current.metadataStatus !== "pending") return;

  try {
    // A {tmdb-...} folder tag lets us skip fuzzy search entirely; fall
    // back to search if the tagged id turns out to be stale/wrong.
    let details = tmdbId ? await getMovieDetails(tmdbId, { append: ["release_dates"] }).catch(() => null) : null;
    let matchedId = tmdbId;
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
      })
      .where(eq(titles.id, titleId));
  } catch {
    // Leave as pending; a later rescan (or admin manual match) retries this.
  }
}

// ── Shows ────────────────────────────────────────────────────────────────

async function syncShowFolder(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry
): Promise<boolean> {
  const { name, year, tmdbId } = parseTitleFolderName(folder.name);

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
  if (!existing) {
    // A {tmdb-...} folder tag lets us skip fuzzy search entirely; fall
    // back to search if the tagged id turns out to be stale/wrong.
    let details = tmdbId ? await getTvShowDetails(tmdbId, { append: ["content_ratings", "external_ids"] }).catch(() => null) : null;
    if (details) tmdbShowId = tmdbId;
    if (!details) {
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
        })
        .where(eq(titles.id, title.id));
    } else {
      await db
        .update(titles)
        .set({ metadataStatus: "not_found" })
        .where(eq(titles.id, title.id));
    }
  } else {
    tmdbShowId = title.tmdbId;
  }

  const seasonFolders = (await provider.listFolder(folder.id)).filter(
    (e) => e.kind === "folder"
  );

  for (const seasonFolder of seasonFolders) {
    const seasonNumber = parseSeasonFolderName(seasonFolder.name);
    if (seasonNumber === null) continue;

    const [season] = await db
      .insert(seasons)
      .values({ titleId: title.id, number: seasonNumber, boxFolderId: seasonFolder.id })
      .onConflictDoUpdate({
        target: seasons.boxFolderId,
        set: { number: seasonNumber },
      })
      .returning();

    const tmdbEpisodes = tmdbShowId
      ? await getSeasonEpisodes(tmdbShowId, seasonNumber).catch(() => [])
      : [];

    const seasonVideo = (await provider.listFolder(seasonFolder.id)).filter(
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

    // Group files by episode number first (mirroring how a movie's segments
    // are grouped) rather than upserting per-file. Processing one file at a
    // time here would (a) let a second part's upsert delete the first
    // part's media_files row, since each call would see only itself as
    // "current", and (b) never detect a removed/renamed episode file, since
    // a missing file just never appears in the loop at all. A multi-episode
    // file ("S01E05-E06") attaches to every episode number it spans — see
    // groupEpisodeFiles.
    const episodeGroups = groupEpisodeFiles(episodeFiles, knownEpisodeNumbers);

    const currentEpisodeRows: { id: string }[] = [];

    for (const [episodeNumber, { files, combined }] of episodeGroups) {
      const orderedFiles = orderMediaSegments(files);
      const parsed = parseEpisodeFileName(orderedFiles[0].name);
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
          boxFolderId: seasonFolder.id,
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

  const [pendingTitleFiles, pendingEpisodeFiles, pendingVariantFiles] = await Promise.all([
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
  ]);
  const pending = [...pendingTitleFiles, ...pendingEpisodeFiles, ...pendingVariantFiles];
  const incomplete = await probeFiles(provider, pending, deadline, errors);

  await backfillCodecs(provider, titleIds, episodeIds, deadline);

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

  const provider = createBoxProviderForServer(library.serverId);
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
      await backfillExternalRatings(library.id, deadline, titleId);
    }
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
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

  await probeFiles(provider, pending, deadline, errors);
  if (kind !== "audiobook") await backfillCodecs(provider, titleOwned ? [titleId] : [], episodeIds, deadline);
  if (titleOwned) await rollupTitleRuntime(titleId);
  else if (episodeIds.length > 0) await resolveEpisodeSplits(episodeIds);
}
