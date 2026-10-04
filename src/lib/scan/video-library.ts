/**
 * Scanning a video ("generic") library. Every video file becomes one title (kind 'movie', so
 * playback, progress, playlists and search work unchanged) named from the file itself; no
 * external metadata service is ever consulted. A title is keyed by its Box FILE id, stored in
 * `box_folder_id` as 'file:<id>' (a stable unique key that can never collide with a folder id),
 * so a file that moves between folders keeps its title, watch history and playlist entries.
 * The folder it sits in is `folder_path` (library-relative, '' = the root) and `parent_folder_id`.
 *
 * Nothing here deletes anything: a file removed from Box leaves its title behind until pruning
 * ships as its own, separately switched feature (every other library kind behaves the same).
 *
 * The app has ONE database connection, so each directory is written in a single transaction that
 * uses only `tx`, and all Box I/O happens before it starts.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { isBrowserFriendlyVariant, isVideoFile, stripVariantSuffix } from "@/lib/scan/conventions";
import {
  linkVariantFiles,
  pendingCodecProbeCondition,
  pendingProbeCondition,
  probeCodecsForPending,
  probeFiles,
  rollupTitleRuntime,
} from "@/lib/scan/media-files";
import { readTagsAndArtwork } from "@/lib/scan/video-artwork";
import { decodeSub, encodeSub, walkVideoTree } from "@/lib/scan/video-walk";
import { CONTENTION_CODES, retryOnContention } from "@/lib/playlists/retry";

/** Postgres lock_not_available: the 5 s lock_timeout on the library row fired. */
const LOCK_TIMEOUT = "55P03";

const CHUNK = 500;
/** Per pass, so a huge library's probing is spread over passes instead of loading every pending row at once. */
const PROBE_BATCH = 300;

/** Video-ish files Roam can't read or play (it handles .mp4 .m4v .mov); counted so the admin is told, never listed as titles. */
const UNSUPPORTED_VIDEO_EXTENSIONS = new Set([".mkv", ".avi", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv"]);

export function isUnsupportedVideo(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot !== -1 && UNSUPPORTED_VIDEO_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

/**
 * A display name (and year, when the name ends in "(YYYY)") from a filename: extension dropped;
 * "my_vacation_2019" style names (separators, no spaces) turned into words; whitespace tidied.
 */
export function titleFromFileName(fileName: string): { name: string; year: number | null } {
  const dot = fileName.lastIndexOf(".");
  let base = dot > 0 ? fileName.slice(0, dot) : fileName;
  if (!/\s/.test(base) && /[._]/.test(base)) base = base.replace(/[._]+/g, " ");
  base = base.replace(/\s+/g, " ").trim();
  let year: number | null = null;
  const m = base.match(/^(.*?)\s*\((\d{4})\)$/);
  if (m && m[1]) {
    const y = Number(m[2]);
    if (y >= 1888 && y <= 2100) {
      base = m[1].trim();
      year = y;
    }
  }
  return { name: base || fileName, year };
}

/** A folder name made safe to store in a path: control characters and backslashes become "_", and "." / ".." can't be segments. */
function pathSegment(name: string): string {
  const clean = name.replace(/[\\\u0000-\u001f\u007f]/g, "_");
  return clean === "" || clean === "." || clean === ".." ? "_" : clean;
}

/** Library-relative folder path for a directory: the top-level folder's name, then the names beneath it. */
export function libraryPath(topName: string | null, namePath: string[]): string {
  return [...(topName === null ? [] : [topName]), ...namePath].map(pathSegment).join("/");
}

export interface DirectorySyncResult {
  /** New titles created. */
  added: number;
  /** Video files seen (variants excluded). */
  seen: number;
  /** Files in formats Roam can't play, skipped. */
  unsupported: number;
  /** Files whose Box id already belongs to a title in a DIFFERENT library (overlapping folders); left untouched. */
  conflicts: number;
  /** The library moved on to a newer scan cycle while this pass was running: nothing was written, and this pass should stop. */
  stale?: boolean;
}

/**
 * Brings one directory's videos into the database, in ONE transaction using only `tx`:
 * 1. lock the library row FOR SHARE and read its rating (a concurrent rating change waits for us,
 *    and anything we write afterwards sees the new value), 2. upsert a title per file (a name that
 *    came from the file's own tags is never overwritten by the filename), 3. upsert each title's
 *    media file, 4. link remuxed variants (`name.aac.mp4`) to their originals.
 */
export async function syncVideoDirectory(
  libraryId: string,
  parentFolderId: string,
  folderPath: string,
  entries: StorageEntry[],
  /** The scan cycle this pass belongs to (null when there is none, e.g. a cycle that began before cycles existed). Videos seen are stamped with it. */
  cycleId: string | null = null
): Promise<DirectorySyncResult> {
  const files = entries.filter((e) => e.kind === "file");
  const unsupported = files.filter((f) => isUnsupportedVideo(f.name)).length;
  const video = files.filter((f) => isVideoFile(f.name));
  const plainNames = new Set(video.filter((f) => !isBrowserFriendlyVariant(f.name)).map((f) => f.name.toLowerCase()));
  // A remuxed copy (`name.aac.mp4`) is linked to its original; one whose original isn't here is the only copy there is, so it is a title.
  const isLinkedVariant = (f: StorageEntry) => isBrowserFriendlyVariant(f.name) && plainNames.has(stripVariantSuffix(f.name).toLowerCase());
  const variants = video.filter(isLinkedVariant);
  const primaries = video.filter((f) => !isLinkedVariant(f));
  if (primaries.length === 0) return { added: 0, seen: 0, unsupported, conflicts: 0 };

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [library] = await tx
      .select({ ratingAges: libraries.ratingAges, scanCycleId: libraries.scanCycleId })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("share");
    if (!library) throw new Error("This library no longer exists.");
    // A newer scan cycle began (a manual rescan, a webhook): this pass is the loser and must not write,
    // least of all stamp videos with a cycle that is no longer current.
    if (cycleId !== null && library.scanCycleId !== cycleId) {
      return { added: 0, seen: 0, conflicts: 0, stale: true as const };
    }
    const rating = library.ratingAges ?? null;

    const keyOf = (f: StorageEntry) => `file:${f.id}`;
    const existing = new Set<string>();
    for (let i = 0; i < primaries.length; i += CHUNK) {
      const rows = await tx
        .select({ key: titles.boxFolderId })
        .from(titles)
        .where(inArray(titles.boxFolderId, primaries.slice(i, i + CHUNK).map(keyOf)));
      for (const r of rows) existing.add(r.key);
    }

    const titleIdByKey = new Map<string, string>();
    for (let i = 0; i < primaries.length; i += CHUNK) {
      const chunk = primaries.slice(i, i + CHUNK);
      const rows = await tx
        .insert(titles)
        .values(
          chunk.map((f) => {
            // An orphaned remux copy is named after the original it stands in for ("Only.aac.mp4" -> "Only").
            const { name, year } = titleFromFileName(stripVariantSuffix(f.name));
            return {
              libraryId,
              kind: "movie" as const,
              name,
              year,
              boxFolderId: keyOf(f),
              folderPath,
              parentFolderId,
              nameSource: "filename" as const,
              ratingAges: rating,
              ...(cycleId !== null ? { lastSeenCycle: cycleId } : {}),
            };
          })
        )
        .onConflictDoUpdate({
          target: titles.boxFolderId,
          // A title that belongs to another library is never touched (two libraries over overlapping
          // Box folders must not rewrite each other's rows, least of all their age rating).
          setWhere: sql`${titles.libraryId} = excluded.library_id`,
          set: {
            // A name/year read from the file's own tags is never overwritten by the filename.
            name: sql`CASE WHEN ${titles.nameSource} = 'embedded' THEN ${titles.name} ELSE excluded.name END`,
            // A year in the file's tags survives a rescan: a filename without one never wipes it.
            year: sql`CASE WHEN ${titles.nameSource} = 'embedded' THEN ${titles.year} ELSE COALESCE(excluded.year, ${titles.year}) END`,
            folderPath,
            parentFolderId,
            // Always the library's current rating (read under the lock above), never a stale one.
            ratingAges: rating,
            ...(cycleId !== null ? { lastSeenCycle: cycleId } : {}),
            updatedAt: new Date(),
          },
        })
        .returning({ id: titles.id, key: titles.boxFolderId });
      for (const r of rows) titleIdByKey.set(r.key, r.id);
    }

    const owned = primaries.filter((f) => titleIdByKey.has(keyOf(f)));

    // A file replaced in place keeps its Box id but changes size: what we recorded about its contents
    // (duration, codecs, tags, picture) is stale, so it is read again.
    const previousSize = new Map<string, number | null>();
    for (let i = 0; i < owned.length; i += CHUNK) {
      const ids = owned.slice(i, i + CHUNK).map((f) => titleIdByKey.get(keyOf(f))!);
      const rows = await tx
        .select({ ownerId: mediaFiles.ownerId, size: mediaFiles.sizeBytes })
        .from(mediaFiles)
        .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, ids), eq(mediaFiles.partIndex, 0)));
      for (const r of rows) if (r.ownerId) previousSize.set(r.ownerId, r.size);
    }
    const replaced = owned
      .filter((f) => {
        const before = previousSize.get(titleIdByKey.get(keyOf(f))!);
        return before !== undefined && before !== null && f.sizeBytes !== undefined && before !== f.sizeBytes;
      })
      .map((f) => titleIdByKey.get(keyOf(f))!);

    for (let i = 0; i < owned.length; i += CHUNK) {
      await tx
        .insert(mediaFiles)
        .values(
          owned.slice(i, i + CHUNK).map((f) => ({
            ownerKind: "title" as const,
            ownerId: titleIdByKey.get(keyOf(f))!,
            partIndex: 0,
            boxFileId: f.id,
            filename: f.name,
            sizeBytes: f.sizeBytes,
            container: f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase(),
          }))
        )
        .onConflictDoUpdate({
          target: [mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId],
          set: { partIndex: 0, filename: sql`excluded.filename`, sizeBytes: sql`excluded.size_bytes` },
        });
    }

    for (let i = 0; i < replaced.length; i += CHUNK) {
      const ids = replaced.slice(i, i + CHUNK);
      await tx
        .update(mediaFiles)
        .set({ probeStatus: "pending", probeAttempts: 0, durationMs: null, durationSeconds: null, codecProbed: false, codecProbeAttempts: 0 })
        .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, ids)));
      await tx
        .update(titles)
        .set({ tagsAttemptedAt: null, tagAttempts: 0, thumbAttempts: 0, thumbAttemptedAt: null })
        .where(inArray(titles.id, ids));
    }

    await linkVariantFiles("title", [...titleIdByKey.values()], owned, variants, tx);
    return { added: owned.filter((f) => !existing.has(keyOf(f))).length, seen: owned.length, conflicts: primaries.length - owned.length, stale: false as const };
  });

  return { ...outcome, unsupported };
}

export interface VideoTopFolderResult {
  /** Something went wrong in this folder (an unreadable or unwritable directory): the scan cycle can't be trusted to have seen every video. */
  hadErrors: boolean;
  titlesAdded: number;
  filesSeen: number;
  unsupported: number;
  /** False if the pass ran out of budget before finishing this folder. */
  finished: boolean;
  /** True if another scan took over the cursor; stop touching scan state. */
  superseded: boolean;
}

/**
 * Syncs one top-level folder: every directory beneath it, depth first. `afterSub` resumes an
 * interrupted folder after the last completed directory; `onUnitDone(sub)` records that progress
 * (false = another scan now owns the cursor) and `budgetExhausted()` says when to stop early.
 */
export async function syncVideoTopFolder(
  provider: Pick<StorageProvider, "listFolder">,
  libraryId: string,
  top: StorageEntry,
  opts: {
    afterSub: string | null;
    errors: string[];
    budgetExhausted: () => boolean;
    onUnitDone: (sub: string) => Promise<boolean>;
    /** Pause between listing retries (tests pass 0). */
    retryDelayMs?: number;
    /** The scan cycle this pass belongs to; see syncVideoDirectory. */
    cycleId?: string | null;
  }
): Promise<VideoTopFolderResult> {
  const result: VideoTopFolderResult = { hadErrors: false, titlesAdded: 0, filesSeen: 0, unsupported: 0, finished: true, superseded: false };
  const walker = walkVideoTree(provider, top, decodeSub(opts.afterSub), { retryDelayMs: opts.retryDelayMs });

  while (true) {
    // Checked before asking for the next directory, since that is what lists Box.
    if (opts.budgetExhausted()) {
      await walker.return(undefined);
      result.finished = false;
      return result;
    }
    const { value: dir, done } = await walker.next();
    if (done) return result;

    const where = libraryPath(top.name, dir.namePath) || top.name;
    if (dir.error) {
      // Couldn't be listed (and its subfolders weren't visited): say so, and carry on with the rest.
      result.hadErrors = true;
      opts.errors.push(`${where}: couldn't be read (${dir.error}); it will be tried again on the next full scan.`);
    } else {
      try {
        // A directory write that hits a lock timeout (a rating change in flight) or a deadlock is simply tried again.
        const r = await retryOnContention(
          () => syncVideoDirectory(libraryId, dir.idPath[dir.idPath.length - 1] ?? top.id, libraryPath(top.name, dir.namePath), dir.entries, opts.cycleId ?? null),
          [...CONTENTION_CODES, LOCK_TIMEOUT]
        );
        if (r.stale) {
          result.superseded = true;
          await walker.return(undefined);
          return result;
        }
        result.titlesAdded += r.added;
        result.filesSeen += r.seen;
        result.unsupported += r.unsupported;
        if (r.conflicts > 0) opts.errors.push(`${where}: ${conflictNote(r.conflicts)}`);
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        result.hadErrors = true;
        opts.errors.push(`${where}: ${(err as Error).message}`);
      }
    }

    if (!(await opts.onUnitDone(encodeSub(dir.idPath)))) {
      result.superseded = true;
      await walker.return(undefined);
      return result;
    }
  }
}

export function conflictNote(count: number): string {
  return `${count} file${count === 1 ? " is" : "s are"} already part of another library and ${count === 1 ? "was" : "were"} skipped.`;
}

/** The summary line the admin sees after a scan that skipped files in formats Roam can't play. */
export function unsupportedSummary(count: number): string | null {
  return count > 0
    ? `${count} file${count === 1 ? "" : "s"} skipped: unsupported format (Roam plays .mp4, .m4v and .mov).`
    : null;
}

// ── Probing ──────────────────────────────────────────────────────────────

const primaryFiles = alias(mediaFiles, "primary_files");

/**
 * Probes a video library's pending files (duration, then codecs) with library-level predicates, a
 * per-pass cap, and a runtime rollup only for the titles probed this pass. Returns true when work
 * remains (the caller marks the scan incomplete so another pass follows).
 */
export async function probeVideoLibrary(
  provider: StorageProvider,
  libraryId: string,
  deadline: number,
  errors: string[]
): Promise<boolean> {
  const inLibrary = eq(titles.libraryId, libraryId);

  const pendingTitleFiles = await db
    .select({ file: mediaFiles })
    .from(mediaFiles)
    .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(titles.id, mediaFiles.ownerId)))
    .where(and(inLibrary, pendingProbeCondition, isNotNull(mediaFiles.sizeBytes)))
    .orderBy(asc(mediaFiles.id))
    .limit(PROBE_BATCH);

  const pendingVariantFiles = await db
    .select({ file: mediaFiles })
    .from(mediaFiles)
    .innerJoin(primaryFiles, eq(primaryFiles.id, mediaFiles.variantOfMediaFileId))
    .innerJoin(titles, and(eq(primaryFiles.ownerKind, "title"), eq(titles.id, primaryFiles.ownerId)))
    .where(and(inLibrary, pendingProbeCondition, isNotNull(mediaFiles.sizeBytes)))
    .orderBy(asc(mediaFiles.id))
    .limit(PROBE_BATCH);

  const pending = [...pendingTitleFiles, ...pendingVariantFiles].map((r) => r.file);
  let incomplete = pendingTitleFiles.length === PROBE_BATCH || pendingVariantFiles.length === PROBE_BATCH;
  incomplete = (await probeFiles(provider, pending, deadline, errors)) || incomplete;

  // Codecs for files probed before codec detection (or whose inline read failed); a third of the time left.
  const now = Date.now();
  if (deadline > now) {
    const codecFiles = await db
      .select({ file: mediaFiles })
      .from(mediaFiles)
      .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(titles.id, mediaFiles.ownerId)))
      .where(and(inLibrary, pendingCodecProbeCondition))
      .orderBy(asc(mediaFiles.id))
      .limit(PROBE_BATCH);
    if (codecFiles.length === PROBE_BATCH) incomplete = true;
    await probeCodecsForPending(provider, codecFiles.map((r) => r.file), now + (deadline - now) / 3);
  }

  // Names, years, descriptions and pictures read from the files themselves.
  incomplete = (await readTagsAndArtwork(provider, libraryId, deadline, errors)) || incomplete;

  // Runtimes only for titles whose files were just probed (not a query per title in the library).
  const probedTitleIds = [...new Set(pendingTitleFiles.map((r) => r.file.ownerId).filter((id): id is string => id !== null))];
  for (const id of probedTitleIds) await rollupTitleRuntime(id);

  return incomplete;
}
