import { and, eq, inArray, notInArray } from "drizzle-orm";
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
  isVideoFile,
  orderMediaSegments,
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

/** Scans one library's Box folder tree (using its server's own connected Box account) and syncs it into Postgres. */
export async function scanLibrary(
  libraryId: string,
  trigger: "manual" | "cron" | "webhook"
): Promise<ScanResult> {
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
  const errors: string[] = [];
  const provider = createBoxProviderForServer(library.serverId);

  try {
    const topLevel = await provider.listFolder(library.boxFolderId);
    const titleFolders = topLevel.filter((e) => e.kind === "folder");

    for (const folder of titleFolders) {
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

    await probePendingDurations(provider, library.id, errors);
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
  await db
    .update(libraries)
    .set({ lastScannedAt: new Date() })
    .where(eq(libraries.id, library.id));

  return { scanRunId: run.id, filesSeen, titlesAdded, errors };
}

// ── Movies ───────────────────────────────────────────────────────────────

async function syncMovieFolder(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry
): Promise<boolean> {
  const { name, year } = parseTitleFolderName(folder.name);

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
      name,
      year,
      boxFolderId: folder.id,
    })
    .onConflictDoUpdate({
      target: titles.boxFolderId,
      set: { name, year, updatedAt: new Date() },
    })
    .returning();

  const children = await provider.listFolder(folder.id);
  const videoFiles = orderMediaSegments(
    children.filter((c) => c.kind === "file" && isVideoFile(c.name))
  );

  await upsertMediaSegments("title", title.id, videoFiles);
  await enrichMovieMetadataIfNeeded(title.id, name, year);

  return !existing;
}

async function enrichMovieMetadataIfNeeded(
  titleId: string,
  name: string,
  year: number | null
) {
  const [current] = await db
    .select({ metadataStatus: titles.metadataStatus })
    .from(titles)
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!current || current.metadataStatus !== "pending") return;

  try {
    const match = await searchMovie(name, year);
    if (!match) {
      await db
        .update(titles)
        .set({ metadataStatus: "not_found" })
        .where(eq(titles.id, titleId));
      return;
    }
    const details = await getMovieDetails(match.id);
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
  const { name, year } = parseTitleFolderName(folder.name);

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
    const match = await searchTvShow(name, year).catch(() => null);
    if (match) {
      const details = await getTvShowDetails(match.id).catch(() => null);
      tmdbShowId = match.id;
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
      }
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
      (e) => e.kind === "file" && isVideoFile(e.name)
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
  errors: string[]
) {
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

  for (const file of pending) {
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
}
