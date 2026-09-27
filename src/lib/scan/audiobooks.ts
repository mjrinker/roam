import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import {
  AudibleError,
  AudibleRateLimitedError,
  AudibleUnavailableError,
  getAudnexusBook,
  getAudnexusChapters,
  searchAudible,
} from "@/lib/audible/client";
import type { AudibleBook, AudibleSearchResult } from "@/lib/audible/parse";
import { pickBestMatch } from "@/lib/audible/match";
import { collectBookFiles, discoverAuthorUnits } from "@/lib/scan/audiobook-tree";
import { parseBookFolderName } from "@/lib/scan/conventions";
import {
  alignAudnexusChapters,
  embeddedChapters,
  perFileChapters,
  type BookChapter,
} from "@/lib/scan/chapters";
import { pendingProbeCondition, rollupTitleRuntime, upsertMediaSegments } from "@/lib/scan/media-files";

// Layout: <Author>/<Book (Year)>/files, optionally <Author>/<Series>/<Book>.
// A folder that directly holds audio files (or CD1/Disc 2/Part 3 subfolders
// that do) is one book; a folder that only holds other folders is an author
// or a series. Scanning walks one top-level (author) folder at a time, with
// a sub-cursor at the book/series level so a huge author can't stall a pass.

interface BookContext {
  folderAuthor: string | null;
  seriesName: string | null;
}

/** Upserts one book's title row and its ordered audio parts. Returns true if the title is new. */
async function syncBook(
  libraryId: string,
  folder: StorageEntry,
  files: StorageEntry[],
  ctx: BookContext | null
): Promise<boolean> {
  const parsed = parseBookFolderName(folder.name);

  const [existing] = await db
    .select({ id: titles.id, asin: titles.asin })
    .from(titles)
    .where(eq(titles.boxFolderId, folder.id))
    .limit(1);

  // A new or changed {asin-…} tag overrides whatever was matched before.
  const asinChanged = !!parsed.asin && parsed.asin !== existing?.asin;

  const base = { name: parsed.name, year: parsed.year, seriesPosition: parsed.seriesPosition };
  const [title] = await db
    .insert(titles)
    .values({
      libraryId,
      kind: "audiobook",
      boxFolderId: folder.id,
      ...base,
      folderAuthor: ctx?.folderAuthor ?? null,
      seriesName: ctx?.seriesName ?? null,
      asin: parsed.asin,
    })
    .onConflictDoUpdate({
      target: titles.boxFolderId,
      set: {
        ...base,
        // A single-title resync doesn't know the author/series folders above
        // the book, so it leaves them as they were.
        ...(ctx ? { folderAuthor: ctx.folderAuthor, seriesName: ctx.seriesName } : {}),
        ...(asinChanged
          ? { asin: parsed.asin, metadataStatus: "pending" as const, chapters: null, chaptersSource: null }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  // If the set of files changed, chapters built from the old files are stale.
  if (existing) {
    const before = await db
      .select({ id: mediaFiles.boxFileId })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, title.id)))
      .orderBy(asc(mediaFiles.partIndex));
    const same = before.length === files.length && before.every((b, i) => b.id === files[i].id);
    if (!same) {
      await db.update(titles).set({ chapters: null, chaptersSource: null }).where(eq(titles.id, title.id));
    }
  }

  await upsertMediaSegments("title", title.id, files);
  return !existing;
}

export interface AuthorSyncResult {
  titlesAdded: number;
  booksSeen: number;
  /** False if the pass ran out of budget before finishing this folder. */
  finished: boolean;
  /** True if another scan took over the cursor; stop touching scan state. */
  superseded: boolean;
}

/**
 * Syncs one top-level folder: it is itself a book, or an author (books
 * directly inside, or inside series folders). `afterSub` resumes an
 * interrupted author folder after the last fully processed child.
 * `onUnitDone(childName)` records progress (returning false if another scan
 * now owns the cursor) and `budgetExhausted()` says when to stop early.
 */
export async function syncAudiobookTopFolder(
  provider: StorageProvider,
  libraryId: string,
  top: StorageEntry,
  opts: {
    afterSub: string | null;
    errors: string[];
    budgetExhausted: () => boolean;
    onUnitDone: (childName: string) => Promise<boolean>;
  }
): Promise<AuthorSyncResult> {
  const result: AuthorSyncResult = { titlesAdded: 0, booksSeen: 0, finished: true, superseded: false };
  const units = discoverAuthorUnits(provider, top, opts.afterSub);

  while (true) {
    // Checked before asking for the next unit, since that is what lists Box.
    if (opts.budgetExhausted()) {
      await units.return(undefined);
      result.finished = false;
      return result;
    }
    const { value: unit, done } = await units.next();
    if (done) return result;

    if (unit.error) opts.errors.push(`${top.name}/${unit.childName}: ${unit.error}`);
    for (const book of unit.books) {
      try {
        const ctx = { folderAuthor: book.folderAuthor, seriesName: book.seriesName };
        if (await syncBook(libraryId, book.folder, book.files, ctx)) result.titlesAdded++;
        result.booksSeen++;
      } catch (err) {
        if (err instanceof BoxReauthRequiredError) throw err;
        opts.errors.push(`${top.name}/${book.folder.name}: ${(err as Error).message}`);
      }
    }

    // A top folder that is itself a book has no sub-cursor step.
    if (unit.childName !== null && !(await opts.onUnitDone(unit.childName))) {
      result.superseded = true;
      return result;
    }
  }
}

/** Single-title resync: re-lists one book's folder. Author/series context is left untouched. */
export async function syncSingleAudiobook(
  provider: StorageProvider,
  libraryId: string,
  folder: StorageEntry
): Promise<void> {
  const files = await collectBookFiles(provider, await provider.listFolder(folder.id));
  if (!files) throw new Error("No audio files found in this book's folder.");
  await syncBook(libraryId, folder, files, null);
}

// ── Audible metadata ─────────────────────────────────────────────────────

type TitleRow = typeof titles.$inferSelect;

function bookFromSearchResult(r: AudibleSearchResult): AudibleBook {
  return { ...r, summary: null, genres: [] };
}

/** Writes a matched Audible book onto a title. Folder-derived series info is never overwritten. */
async function applyBook(title: TitleRow, book: AudibleBook, status: "matched" | "manual") {
  await db
    .update(titles)
    .set({
      authors: book.authors,
      narrators: book.narrators,
      asin: book.asin,
      posterUrl: book.imageUrl ?? title.posterUrl,
      overview: book.summary ?? title.overview,
      genres: book.genres.length > 0 ? book.genres : title.genres,
      year: title.year ?? book.releaseYear,
      seriesName: title.seriesName ?? book.seriesName,
      seriesPosition: title.seriesPosition ?? book.seriesPosition,
      metadataStatus: status,
      // Embedded chapters outrank Audible's; anything else re-resolves now
      // that an ASIN is known.
      ...(title.chaptersSource === "embedded" ? {} : { chapters: null, chaptersSource: null }),
      updatedAt: new Date(),
    })
    .where(eq(titles.id, title.id));
}

/** Manual match from the admin picker: pins the title to a chosen ASIN. */
export async function matchAudiobookToAsin(titleId: string, asin: string, region: string | null) {
  const [title] = await db.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title || title.kind !== "audiobook") throw new Error("Audiobook not found");
  const book = await getAudnexusBook(asin, region);
  if (!book) throw new Error("Audible has no book with that ASIN.");
  await applyBook(title, book, "manual");
}

async function enrichOne(title: TitleRow, region: string) {
  let book: AudibleBook | null = null;
  if (title.asin) {
    book = await getAudnexusBook(title.asin, region);
  } else {
    const results = await searchAudible({ title: title.name, author: title.folderAuthor }, region);
    const best = pickBestMatch(
      {
        title: title.name,
        author: title.folderAuthor,
        year: title.year,
        runtimeMinutes: title.runtimeSeconds ? title.runtimeSeconds / 60 : null,
      },
      results
    );
    if (best) book = (await getAudnexusBook(best.asin, region)) ?? bookFromSearchResult(best);
  }

  if (!book) {
    await db.update(titles).set({ metadataStatus: "not_found" }).where(eq(titles.id, title.id));
    return;
  }
  await applyBook(title, book, "matched");
}

const ENRICH_BATCH = 20;

/**
 * Matches pending audiobooks against Audible, least-recently-tried first.
 * A rate limit or outage stops the pass quietly and leaves the rest pending
 * for a later scan. Returns true if there may be more to do right now.
 */
export async function enrichPendingAudiobooks(
  libraryId: string,
  region: string,
  deadline: number
): Promise<boolean> {
  const pending = await db
    .select()
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "audiobook"), eq(titles.metadataStatus, "pending")))
    .orderBy(sql`${titles.metadataAttemptedAt} ASC NULLS FIRST`)
    .limit(ENRICH_BATCH);

  for (const title of pending) {
    if (Date.now() > deadline) return true;
    await db.update(titles).set({ metadataAttemptedAt: new Date() }).where(eq(titles.id, title.id));
    try {
      await enrichOne(title, region);
    } catch (err) {
      if (err instanceof AudibleRateLimitedError || err instanceof AudibleUnavailableError) {
        console.warn(`Audible unavailable, leaving audiobooks pending: ${(err as Error).message}`);
        return false;
      }
      if (!(err instanceof AudibleError)) throw err;
      // Not transient (e.g. Audible rejected the query): stop retrying it
      // every pass; the admin can match it by hand.
      console.warn(`Audible lookup failed for "${title.name}": ${err.message}`);
      await db.update(titles).set({ metadataStatus: "not_found" }).where(eq(titles.id, title.id));
    }
  }
  return pending.length === ENRICH_BATCH;
}

// ── Chapters ─────────────────────────────────────────────────────────────

/**
 * Builds a book's chapter list once every part has a duration. Priority:
 * chapters embedded in the files, then Audnexus's (only if its runtime lines
 * up with ours), then one chapter per file. `[]` records "resolved, none".
 * Returns false if it couldn't finish (parts not ready, or Audnexus down) so
 * it is tried again later.
 */
export async function resolveAudiobookChapters(titleId: string, region: string): Promise<boolean> {
  const [title] = await db.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title) return false;

  const files = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId)))
    .orderBy(asc(mediaFiles.partIndex));
  if (files.length === 0) return false;

  const parts = files.map((f) => ({
    filename: f.filename,
    durationMs: f.durationMs ?? (f.durationSeconds ?? NaN) * 1000,
    chapters: f.chapters,
  }));
  if (parts.some((p) => !Number.isFinite(p.durationMs))) return false;
  const totalMs = parts.reduce((sum, p) => sum + p.durationMs, 0);

  let chapters: BookChapter[] | null = embeddedChapters(parts);
  let source: "embedded" | "audnexus" | "files" | null = chapters ? "embedded" : null;

  if (!chapters && title.asin) {
    try {
      const aud = await getAudnexusChapters(title.asin, region);
      const aligned = aud ? alignAudnexusChapters(aud, totalMs) : null;
      if (aligned) {
        chapters = aligned;
        source = "audnexus";
      }
    } catch (err) {
      if (err instanceof AudibleRateLimitedError || err instanceof AudibleUnavailableError) return false;
      if (!(err instanceof AudibleError)) throw err;
    }
  }

  if (!chapters) {
    chapters = perFileChapters(parts);
    source = chapters ? "files" : null;
  }

  await db
    .update(titles)
    .set({ chapters: chapters ?? [], chaptersSource: source })
    .where(eq(titles.id, titleId));
  return true;
}

const CHAPTER_BATCH = 25;

/** Resolves chapters for this library's books whose files are all probed (or given up on). */
export async function resolvePendingAudiobookChapters(
  libraryId: string,
  region: string,
  deadline: number
): Promise<void> {
  const unresolved = await db
    .select({ id: titles.id })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "audiobook"), isNull(titles.chapters)))
    .limit(CHAPTER_BATCH);

  for (const { id } of unresolved) {
    if (Date.now() > deadline) return;
    const [stillProbing] = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id), pendingProbeCondition))
      .limit(1);
    if (stillProbing) continue;
    await rollupTitleRuntime(id);
    await resolveAudiobookChapters(id, region);
  }
}
