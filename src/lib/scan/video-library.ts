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
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, titles, watchState, type TitleKind } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { PLAYABLE_TITLE_KINDS } from "@/lib/libraries/profile";
import { boxTakenAt, photoThumbUrl, thumbVersion } from "@/lib/photos/urls";
import { naturalSortKey } from "@/lib/libraries/sort-key";
import { releaseArtwork } from "@/lib/scan/artwork-store";
import { isBrowserFriendlyVariant, stripVariantSuffix } from "@/lib/scan/conventions";
import { VIDEO_PROFILE, type TreeProfile } from "@/lib/scan/tree-profile";
import {
  linkVariantFiles,
  pendingCodecProbeCondition,
  pendingProbeCondition,
  probeCodecsForPending,
  probeFiles,
  rollupTitleRuntime,
} from "@/lib/scan/media-files";
import { enrichMusicLibrary } from "@/lib/music/enrich";
import { organizeMusicLibrary } from "@/lib/music/organize";
import { readPhotoMetadata } from "@/lib/scan/photo-meta";
import { readTagsAndArtwork } from "@/lib/scan/video-artwork";
import { decodeSub, encodeSub, walkVideoTree } from "@/lib/scan/video-walk";
import { CONTENTION_CODES, retryOnContention } from "@/lib/playlists/retry";

/** Postgres lock_not_available: the 5 s lock_timeout on the library row fired. */
const LOCK_TIMEOUT = "55P03";

const CHUNK = 500;
/** Per pass, so a huge library's probing is spread over passes instead of loading every pending row at once. */
const PROBE_BATCH = 300;

export const isUnsupportedVideo = (fileName: string): boolean => VIDEO_PROFILE.isUnsupported(fileName);

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

/** The file name a title's name is taken from: a remux copy's original name, or a music file's name without its track number. */
function profileFileName(profile: TreeProfile, fileName: string): string {
  const base = profile.linkVariants ? stripVariantSuffix(fileName) : fileName;
  if (!profile.nameFromFile) return base;
  const dot = base.lastIndexOf(".");
  return `${profile.nameFromFile(base)}${dot > 0 ? base.slice(dot) : ""}`;
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
  cycleId: string | null = null,
  profile: TreeProfile = VIDEO_PROFILE
): Promise<DirectorySyncResult> {
  const files = entries.filter((e) => e.kind === "file");
  const unsupported = files.filter((f) => profile.isUnsupported(f.name)).length;
  const video = files.filter((f) => profile.isMedia(f.name));
  const plainNames = new Set(video.filter((f) => !isBrowserFriendlyVariant(f.name)).map((f) => f.name.toLowerCase()));
  // A remuxed copy (`name.aac.mp4`) is linked to its original; one whose original isn't here is the only copy there is, so it is a title.
  // Only for video: in an audio library "x.aac.m4a" is just a file called that.
  const isLinkedVariant = (f: StorageEntry) => profile.linkVariants && isBrowserFriendlyVariant(f.name) && plainNames.has(stripVariantSuffix(f.name).toLowerCase());
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
    const scannedAt = new Date();
    // Photo libraries date every item at once (Box's date, else now), so the timeline works before any metadata is read.
    const dated = (f: StorageEntry) => (profile.photoMeta ? { takenAt: boxTakenAt(f, scannedAt).at, takenAtSource: boxTakenAt(f, scannedAt).source } : {});

    const keyOf = (f: StorageEntry) => `file:${f.id}`;
    // What each file was last time (only titles of THIS library: another library's rows are left alone).
    const existing = new Set<string>();
    const kindBefore = new Map<string, TitleKind>();
    for (let i = 0; i < primaries.length; i += CHUNK) {
      const rows = await tx
        .select({ key: titles.boxFolderId, kind: titles.kind, libraryId: titles.libraryId })
        .from(titles)
        .where(inArray(titles.boxFolderId, primaries.slice(i, i + CHUNK).map(keyOf)));
      for (const r of rows) {
        existing.add(r.key);
        if (r.libraryId === libraryId) kindBefore.set(r.key, r.kind);
      }
    }

    const titleIdByKey = new Map<string, string>();
    for (let i = 0; i < primaries.length; i += CHUNK) {
      const chunk = primaries.slice(i, i + CHUNK);
      const rows = await tx
        .insert(titles)
        .values(
          chunk.map((f) => {
            // An orphaned remux copy is named after the original it stands in for ("Only.aac.mp4" -> "Only").
            const { name, year } = titleFromFileName(profileFileName(profile, f.name));
            return {
              libraryId,
              kind: profile.titleKindFor(f.name),
              name,
              year,
              boxFolderId: keyOf(f),
              folderPath,
              parentFolderId,
              sortKey: naturalSortKey(profile.linkVariants ? stripVariantSuffix(f.name) : f.name),
              nameSource: "filename" as const,
              ratingAges: rating,
              ...dated(f),
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
            // A name/year read from the file's own tags (or matched online) is never overwritten by the filename.
            name: sql`CASE WHEN ${titles.nameSource} IN ('embedded', 'online') THEN ${titles.name} ELSE excluded.name END`,
            // A year in the file's tags survives a rescan: a filename without one never wipes it.
            year: sql`CASE WHEN ${titles.nameSource} IN ('embedded', 'online') THEN ${titles.year} ELSE COALESCE(excluded.year, ${titles.year}) END`,
            folderPath,
            parentFolderId,
            sortKey: sql`excluded.sort_key`,
            // A file renamed from a picture to a video (or back) keeps its Box id but is a different kind of item.
            kind: sql`excluded.kind`,
            // Always the library's current rating (read under the lock above), never a stale one.
            ratingAges: rating,
            ...(profile.photoMeta
              ? {
                  // A date read from the picture itself is never replaced by Box's; a scan-time guess never replaces a date we already have.
                  takenAt: sql`CASE WHEN ${titles.takenAtSource} = 'exif' THEN ${titles.takenAt} WHEN excluded.taken_at_source = 'scan' THEN COALESCE(${titles.takenAt}, excluded.taken_at) ELSE excluded.taken_at END`,
                  takenAtSource: sql`CASE WHEN ${titles.takenAtSource} = 'exif' THEN 'exif' WHEN excluded.taken_at_source = 'scan' THEN COALESCE(${titles.takenAtSource}, 'scan') ELSE excluded.taken_at_source END`,
                }
              : {}),
            ...(cycleId !== null ? { lastSeenCycle: cycleId } : {}),
            // Seen in Box again: whatever made it look missing is over.
            missingSince: null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: titles.id, key: titles.boxFolderId });
      for (const r of rows) titleIdByKey.set(r.key, r.id);
    }

    const owned = primaries.filter((f) => titleIdByKey.has(keyOf(f)));

    // Files whose kind changed (a picture became a video or the reverse): what we know about the old
    // kind (progress, picture, tags, probe state) does not describe the new one, so it is reset below.
    const switchedFiles = owned.filter((f) => {
      const before = kindBefore.get(keyOf(f));
      return before !== undefined && before !== profile.titleKindFor(f.name);
    });

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
    const replacedFiles = owned.filter((f) => {
      const before = previousSize.get(titleIdByKey.get(keyOf(f))!);
      return before !== undefined && before !== null && f.sizeBytes !== undefined && before !== f.sizeBytes;
    });

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
            // A picture has nothing to probe: born 'ok', so no prober ever opens it.
            ...(profile.needsProbe(f.name) ? {} : { probeStatus: "ok" as const }),
          }))
        )
        .onConflictDoUpdate({
          target: [mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId],
          set: { partIndex: 0, filename: sql`excluded.filename`, sizeBytes: sql`excluded.size_bytes` },
        });
    }

    // The old picture and tag-derived name belong to the old contents: drop them, so if the new file has no
    // tags the title falls back to its filename instead of keeping a stale cover and name. The same goes
    // for a file whose kind changed, which is also stripped of progress that described the old kind.
    const resetFiles = [...new Map([...replacedFiles, ...switchedFiles].map((f) => [keyOf(f), f])).values()];
    const resetIds = resetFiles.map((f) => titleIdByKey.get(keyOf(f))!);
    await releaseArtwork(tx, resetIds);
    for (const f of resetFiles) {
      const { name, year } = titleFromFileName(profileFileName(profile, f.name));
      await tx
        .update(titles)
        .set({ name, year, nameSource: "filename", posterUrl: null, ...(profile.photoMeta ? { takenAt: boxTakenAt(f, scannedAt).at, takenAtSource: boxTakenAt(f, scannedAt).source } : {}) })
        .where(eq(titles.id, titleIdByKey.get(keyOf(f))!));
    }
    for (let i = 0; i < resetIds.length; i += CHUNK) {
      const ids = resetIds.slice(i, i + CHUNK);
      await tx
        .update(titles)
        .set({
          tagsAttemptedAt: null, tagAttempts: 0, thumbAttempts: 0, thumbAttemptedAt: null, chapters: null, chaptersSource: null, authors: null, seriesName: null,
          width: null, height: null, metaAttemptedAt: null, metaAttempts: 0, runtimeSeconds: null,
        })
        .where(inArray(titles.id, ids));
    }
    // Probe state per file: a video is read again, a picture has nothing to read.
    const idsByNeed = (need: boolean) => resetFiles.filter((f) => profile.needsProbe(f.name) === need).map((f) => titleIdByKey.get(keyOf(f))!);
    for (const [need, ids] of [[true, idsByNeed(true)], [false, idsByNeed(false)]] as const) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        await tx
          .update(mediaFiles)
          .set({ probeStatus: need ? "pending" : "ok", probeAttempts: 0, durationMs: null, durationSeconds: null, codecProbed: false, codecProbeAttempts: 0, audioCodec: null, videoCodec: null })
          .where(and(eq(mediaFiles.ownerKind, "title"), inArray(mediaFiles.ownerId, ids.slice(i, i + CHUNK))));
      }
    }
    // Progress on a file that is no longer something that plays belongs to nothing: dropped.
    const noLongerPlayable = switchedFiles.filter((f) => !PLAYABLE_TITLE_KINDS.includes(profile.titleKindFor(f.name))).map((f) => titleIdByKey.get(keyOf(f))!);
    for (let i = 0; i < noLongerPlayable.length; i += CHUNK) {
      await tx.delete(watchState).where(and(eq(watchState.ownerKind, "title"), inArray(watchState.ownerId, noLongerPlayable.slice(i, i + CHUNK))));
    }

    // Each item points at its live thumbnail (set last: a reset above cleared the old one). The version
    // changes only when the file's content does, so browsers can keep a thumbnail for a year.
    if (profile.photoMeta) {
      for (let i = 0; i < owned.length; i += CHUNK) {
        const rows = owned.slice(i, i + CHUNK).map((f) => sql`(${titleIdByKey.get(keyOf(f))!}::uuid, ${photoThumbUrl(titleIdByKey.get(keyOf(f))!, thumbVersion(f))})`);
        await tx.execute(sql`UPDATE titles t SET poster_url = v.url FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, url) WHERE t.id = v.id AND t.poster_url IS DISTINCT FROM v.url`);
      }
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
    /** Which kind of file-tree library (default video). */
    profile?: TreeProfile;
    /**
     * Awaited when a directory failed, BEFORE the cursor is moved past it. If the process dies between
     * stepping past an unread directory and flagging the cycle, the next pass would otherwise treat a
     * cycle that missed a directory as clean.
     */
    onError?: () => Promise<void>;
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
      await opts.onError?.();
      opts.errors.push(`${where}: couldn't be read (${dir.error}); it will be tried again on the next full scan.`);
    } else {
      try {
        // A directory write that hits a lock timeout (a rating change in flight) or a deadlock is simply tried again.
        const r = await retryOnContention(
          () => syncVideoDirectory(libraryId, dir.idPath[dir.idPath.length - 1] ?? top.id, libraryPath(top.name, dir.namePath), dir.entries, opts.cycleId ?? null, opts.profile ?? VIDEO_PROFILE),
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
        await opts.onError?.();
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
export function unsupportedSummary(count: number, profile: TreeProfile = VIDEO_PROFILE): string | null {
  return count > 0
    ? `${count} file${count === 1 ? "" : "s"} skipped: unsupported format (${profile.supportedHint}).`
    : null;
}

// ── Chapters ──

/**
 * A one-file title's chapters live on its media file once probed; the audio player reads them from the
 * title. Copies them across for titles that have none yet. Never touches Audible-sourced chapters
 * (generic audio has none) and never runs a title with no embedded chapters.
 */
export async function copyEmbeddedChapters(libraryId: string): Promise<void> {
  await db.execute(sql`
    UPDATE titles t
    SET chapters = m.chapters, chapters_source = 'embedded'
    FROM media_files m
    WHERE t.library_id = ${libraryId}
      AND t.kind <> 'photo'
      AND m.owner_kind = 'title' AND m.owner_id = t.id AND m.part_index = 0
      AND t.chapters IS NULL
      AND m.probe_status = 'ok'
      AND m.chapters IS NOT NULL AND jsonb_array_length(m.chapters) > 0`);
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
  errors: string[],
  profile: TreeProfile = VIDEO_PROFILE
): Promise<boolean> {
  const inLibrary = eq(titles.libraryId, libraryId);
  // A picture has no duration or codecs: the MP4 prober must never be pointed at one.
  const notPhoto = ne(titles.kind, "photo");

  const pendingTitleFiles = await db
    .select({ file: mediaFiles })
    .from(mediaFiles)
    .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(titles.id, mediaFiles.ownerId)))
    .where(and(inLibrary, notPhoto, pendingProbeCondition, isNotNull(mediaFiles.sizeBytes)))
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
  if (profile.probeCodecs && deadline > now) {
    const codecFiles = await db
      .select({ file: mediaFiles })
      .from(mediaFiles)
      .innerJoin(titles, and(eq(mediaFiles.ownerKind, "title"), eq(titles.id, mediaFiles.ownerId)))
      .where(and(inLibrary, notPhoto, pendingCodecProbeCondition))
      .orderBy(asc(mediaFiles.id))
      .limit(PROBE_BATCH);
    if (codecFiles.length === PROBE_BATCH) incomplete = true;
    await probeCodecsForPending(provider, codecFiles.map((r) => r.file), now + (deadline - now) / 3);
  }

  // Embedded chapters (m4b, MP3 CHAP) onto the titles whose files were just probed, where the player reads them.
  if (profile.chapters) await copyEmbeddedChapters(libraryId);

  // Names, years, descriptions and pictures read from the files themselves.
  if (profile.readTags) incomplete = (await readTagsAndArtwork(provider, libraryId, deadline, errors, profile)) || incomplete;

  // Music libraries: tracks into artists and albums, from their folders (after the tags above, which can name a root-level track's artist).
  if (profile.groupsIntoAlbums) {
    incomplete = !(await organizeMusicLibrary(libraryId, deadline)).complete || incomplete;
    // ...then names, years, track titles and covers from MusicBrainz for the albums found.
    incomplete = (await enrichMusicLibrary(libraryId, deadline, errors)) || incomplete;
  }

  // Photo libraries: when each picture was taken and how big it is, from the picture itself.
  if (profile.photoMeta) incomplete = (await readPhotoMetadata(provider, libraryId, deadline, errors)) || incomplete;

  // Runtimes only for titles whose files were just probed (not a query per title in the library).
  const probedTitleIds = [...new Set(pendingTitleFiles.map((r) => r.file.ownerId).filter((id): id is string => id !== null))];
  for (const id of probedTitleIds) await rollupTitleRuntime(id);

  return incomplete;
}
