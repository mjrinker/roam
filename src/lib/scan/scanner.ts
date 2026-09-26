import { and, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  episodes,
  libraries,
  mediaFiles,
  scanRuns,
  seasons,
  titles,
} from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  groupFilesByEpisodeNumber,
  isExtraFile,
  isVideoFile,
  orderMediaSegments,
  parseEditionTag,
  parseEpisodeFileName,
  parseSeasonFolderName,
  parseTitleFolderName,
} from "@/lib/scan/conventions";
import { probeMp4DurationSeconds } from "@/lib/scan/mp4-duration";
import {
  getMovieDetails,
  getSeasonEpisodes,
  getTvShowDetails,
  searchMovie,
  searchTvShow,
  tmdbImageUrl,
} from "@/lib/tmdb/client";

export interface ScanResult {
  scanRunId: string;
  filesSeen: number;
  titlesAdded: number;
  errors: string[];
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
// still-incomplete library just needs another Rescan (or the next
// scheduled cron run) to keep making progress, exactly like the cron
// batching in api/cron/scan already does across libraries.
const SCAN_TIME_BUDGET_MS = 40_000;
const FOLDER_SYNC_TIME_BUDGET_MS = 24_000; // ~60% of the budget — leaves room for probing to run every pass too, so titles start becoming playable before the whole library has even finished being discovered

/** Scans one library's Box folder tree (using its server's own connected Box account) and syncs it into Postgres. */
export async function scanLibrary(
  libraryId: string,
  trigger: "manual" | "cron" | "webhook" | "resume"
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
  const errors: string[] = [];
  const provider = createBoxProviderForServer(library.serverId);

  try {
    const topLevel = await provider.listFolder(library.boxFolderId);
    const titleFolders = topLevel.filter((e) => e.kind === "folder");

    for (const folder of titleFolders) {
      if (Date.now() - startedAt > FOLDER_SYNC_TIME_BUDGET_MS) {
        incomplete = true;
        break;
      }
      try {
        if (library.kind === "movies") {
          const added = await syncMovieFolder(provider, library.id, folder);
          if (added) titlesAdded++;
          filesSeen += 1;
        } else {
          const added = await syncShowFolder(provider, library.id, folder);
          if (added) titlesAdded++;
        }
      } catch (err) {
        // A single title's own Box connection dying mid-scan means every
        // OTHER title will fail the same way — short-circuit with one
        // clear error instead of one near-identical message per folder.
        if (err instanceof BoxReauthRequiredError) throw err;
        errors.push(`${folder.name}: ${(err as Error).message}`);
      }
    }

    const probeDeadline = startedAt + SCAN_TIME_BUDGET_MS;
    const probeIncomplete = await probePendingDurations(provider, library.id, probeDeadline, errors);
    incomplete = incomplete || probeIncomplete;
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
      errors.push("This server's Box connection needs to be reconnected by an admin.");
    } else {
      errors.push((err as Error).message);
    }
  }

  if (incomplete) {
    errors.push(
      "This library is large enough that one scan couldn't finish everything — it'll resume automatically (on the next page load, or the scheduled scan) to keep making progress."
    );
  }

  await db
    .update(scanRuns)
    .set({ finishedAt: new Date(), filesSeen, titlesAdded, errors })
    .where(eq(scanRuns.id, run.id));
  await db
    .update(libraries)
    .set({ lastScannedAt: new Date(), scanIncomplete: incomplete })
    .where(eq(libraries.id, library.id));

  return { scanRunId: run.id, filesSeen, titlesAdded, errors };
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
  const candidateFiles = children.filter(
    (c) => c.kind === "file" && isVideoFile(c.name) && !isExtraFile(c.name)
  );
  const videoFiles = orderMediaSegments(selectPrimaryEdition(candidateFiles));

  await upsertMediaSegments("title", title.id, videoFiles);
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
    let details = tmdbId ? await getMovieDetails(tmdbId).catch(() => null) : null;
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
      details = await getMovieDetails(matchedId);
    }
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "matched",
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
    let details = tmdbId ? await getTvShowDetails(tmdbId).catch(() => null) : null;
    if (details) tmdbShowId = tmdbId;
    if (!details) {
      const match = await searchTvShow(name, year).catch(() => null);
      if (match) {
        details = await getTvShowDetails(match.id).catch(() => null);
        tmdbShowId = match.id;
      }
    }
    if (details) {
      await db
        .update(titles)
        .set({
          tmdbId: details.id,
          overview: details.overview ?? null,
          posterUrl: tmdbImageUrl(details.poster_path, "w500"),
          backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
          genres: details.genres?.map((g) => g.name) ?? [],
          metadataStatus: "matched",
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

    const episodeFiles = (await provider.listFolder(seasonFolder.id)).filter(
      (e) => e.kind === "file" && isVideoFile(e.name) && !isExtraFile(e.name)
    );

    // Group files by episode number first (mirroring how a movie's segments
    // are grouped) rather than upserting per-file. Processing one file at a
    // time here would (a) let a second part's upsert delete the first
    // part's media_files row, since each call would see only itself as
    // "current", and (b) never detect a removed/renamed episode file, since
    // a missing file just never appears in the loop at all.
    const filesByEpisodeNumber = groupFilesByEpisodeNumber(episodeFiles);

    const currentEpisodeRows: { id: string }[] = [];

    for (const [episodeNumber, files] of filesByEpisodeNumber) {
      const orderedFiles = orderMediaSegments(files);
      const parsedName = parseEpisodeFileName(orderedFiles[0].name)?.name ?? null;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === episodeNumber);

      const [episode] = await db
        .insert(episodes)
        .values({
          seasonId: season.id,
          number: episodeNumber,
          name: parsedName ?? tmdbEp?.name ?? null,
          boxFolderId: seasonFolder.id,
          tmdbId: tmdbEp?.id ?? null,
          overview: tmdbEp?.overview ?? null,
          stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
          runtimeSeconds: tmdbEp?.runtime ? tmdbEp.runtime * 60 : null,
        })
        .onConflictDoUpdate({
          target: [episodes.seasonId, episodes.number],
          set: {
            name: parsedName ?? tmdbEp?.name ?? null,
            tmdbId: tmdbEp?.id ?? null,
            overview: tmdbEp?.overview ?? null,
            stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
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

  for (const season of showSeasons) {
    const tmdbEpisodes = await getSeasonEpisodes(tmdbShowId, season.number).catch(() => []);
    if (tmdbEpisodes.length === 0) continue;

    const existingEpisodes = await db
      .select()
      .from(episodes)
      .where(eq(episodes.seasonId, season.id));

    for (const ep of existingEpisodes) {
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
}

// ── Media file segments ──────────────────────────────────────────────────

async function upsertMediaSegments(
  ownerKind: "title" | "episode",
  ownerId: string,
  files: StorageEntry[]
) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await db
      .insert(mediaFiles)
      .values({
        ownerKind,
        ownerId,
        partIndex: i,
        boxFileId: file.id,
        filename: file.name,
        sizeBytes: file.sizeBytes,
        container: file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase(),
      })
      .onConflictDoUpdate({
        target: mediaFiles.boxFileId,
        set: { partIndex: i, filename: file.name, sizeBytes: file.sizeBytes },
      });
  }

  // Drop rows for files that no longer exist under this owner (removed or
  // renamed in Box since the last scan).
  const currentIds = files.map((f) => f.id);
  if (currentIds.length > 0) {
    await db
      .delete(mediaFiles)
      .where(
        and(
          eq(mediaFiles.ownerKind, ownerKind),
          eq(mediaFiles.ownerId, ownerId),
          notInArray(mediaFiles.boxFileId, currentIds)
        )
      );
  }
}

// ── Duration probing ─────────────────────────────────────────────────────

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
  errors: string[]
): Promise<boolean> {
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

  const [pendingTitleFiles, pendingEpisodeFiles] = await Promise.all([
    titleIds.length
      ? db
          .select()
          .from(mediaFiles)
          .where(
            and(
              eq(mediaFiles.probeStatus, "pending"),
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
              eq(mediaFiles.probeStatus, "pending"),
              eq(mediaFiles.ownerKind, "episode"),
              inArray(mediaFiles.ownerId, episodeIds)
            )
          )
      : Promise.resolve([]),
  ]);
  const pending = [...pendingTitleFiles, ...pendingEpisodeFiles];
  let incomplete = false;

  for (const file of pending) {
    if (Date.now() > deadline) {
      incomplete = true;
      break;
    }
    if (!file.sizeBytes) continue;
    try {
      const durationSeconds = await probeMp4DurationSeconds(
        (start, end) => provider.fetchByteRange(file.boxFileId, start, end),
        file.sizeBytes
      );
      await db
        .update(mediaFiles)
        .set({
          durationSeconds: Math.round(durationSeconds),
          probeStatus: "ok",
        })
        .where(eq(mediaFiles.id, file.id));
    } catch (err) {
      if (err instanceof BoxReauthRequiredError) throw err;
      errors.push(`probe ${file.filename}: ${(err as Error).message}`);
      await db
        .update(mediaFiles)
        .set({ probeStatus: "failed" })
        .where(eq(mediaFiles.id, file.id));
    }
  }

  // Roll up movie runtimes from their segments' probed durations — this
  // library's movies only.
  const movieTitles = titleIds.length
    ? await db
        .select({ id: titles.id })
        .from(titles)
        .where(and(inArray(titles.id, titleIds), eq(titles.kind, "movie")))
    : [];
  for (const t of movieTitles) {
    const segments = await db
      .select({ durationSeconds: mediaFiles.durationSeconds })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, t.id)));
    if (segments.length === 0 || segments.some((s) => s.durationSeconds == null)) continue;
    const total = segments.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
    await db.update(titles).set({ runtimeSeconds: total }).where(eq(titles.id, t.id));
  }

  return incomplete;
}
