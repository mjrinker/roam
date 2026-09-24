import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  episodes,
  libraries,
  mediaFiles,
  scanRuns,
  seasons,
  titles,
} from "@/lib/db/schema";
import { boxProvider } from "@/lib/storage/box";
import type { StorageEntry } from "@/lib/storage/provider";
import {
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

/** Scans one library's Box folder tree and syncs it into Postgres. */
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

  const [run] = await db
    .insert(scanRuns)
    .values({ libraryId, trigger })
    .returning();

  let filesSeen = 0;
  let titlesAdded = 0;
  const errors: string[] = [];

  try {
    const topLevel = await boxProvider.listFolder(library.boxFolderId);
    const titleFolders = topLevel.filter((e) => e.kind === "folder");

    for (const folder of titleFolders) {
      try {
        if (library.kind === "movies") {
          const added = await syncMovieFolder(library.id, folder);
          if (added) titlesAdded++;
          filesSeen += 1;
        } else {
          const added = await syncShowFolder(library.id, folder);
          if (added) titlesAdded++;
        }
      } catch (err) {
        errors.push(`${folder.name}: ${(err as Error).message}`);
      }
    }

    await probePendingDurations(errors);
  } catch (err) {
    errors.push((err as Error).message);
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

  const children = await boxProvider.listFolder(folder.id);
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

  const seasonFolders = (await boxProvider.listFolder(folder.id)).filter(
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

    const episodeFiles = (await boxProvider.listFolder(seasonFolder.id)).filter(
      (e) => e.kind === "file" && isVideoFile(e.name)
    );

    for (const file of episodeFiles) {
      const parsed = parseEpisodeFileName(file.name);
      if (!parsed) continue;

      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === parsed.episode);

      const [episode] = await db
        .insert(episodes)
        .values({
          seasonId: season.id,
          number: parsed.episode,
          name: parsed.name ?? tmdbEp?.name ?? null,
          boxFolderId: seasonFolder.id,
          tmdbId: tmdbEp?.id ?? null,
          overview: tmdbEp?.overview ?? null,
          stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
          runtimeSeconds: tmdbEp?.runtime ? tmdbEp.runtime * 60 : null,
        })
        .onConflictDoUpdate({
          target: [episodes.seasonId, episodes.number],
          set: {
            name: parsed.name ?? tmdbEp?.name ?? null,
            tmdbId: tmdbEp?.id ?? null,
            overview: tmdbEp?.overview ?? null,
            stillUrl: tmdbImageUrl(tmdbEp?.still_path, "w500"),
          },
        })
        .returning();

      await upsertMediaSegments("episode", episode.id, [file]);
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

async function probePendingDurations(errors: string[]) {
  const pending = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.probeStatus, "pending"));

  for (const file of pending) {
    if (!file.sizeBytes) continue;
    try {
      const durationSeconds = await probeMp4DurationSeconds(
        (start, end) => boxProvider.fetchByteRange(file.boxFileId, start, end),
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
      errors.push(`probe ${file.filename}: ${(err as Error).message}`);
      await db
        .update(mediaFiles)
        .set({ probeStatus: "failed" })
        .where(eq(mediaFiles.id, file.id));
    }
  }

  // Roll up movie runtimes from their segments' probed durations.
  const movieTitles = await db.select({ id: titles.id }).from(titles).where(eq(titles.kind, "movie"));
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
