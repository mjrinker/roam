/**
 * Finding duplicate photos in a photo library, and hiding the copies an admin doesn't want to see. Nothing here touches the storage: a "hidden"
 * copy is only marked as a duplicate of the photo kept, left out of the timeline and other listings, and can be restored at any time.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, mediaFiles, titles } from "@/lib/db/schema";
import { dHash, distance, groupAlike, HASH_HEIGHT, HASH_WIDTH, isHash, suggestKeep } from "./hash";
import { photoThumbUrl, thumbVersion } from "@/lib/photos/urls";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A failed try is left alone this long before it is tried again. */
export const RETRY_AFTER_MS = 7 * 86_400_000;
/** The distances offered: identical copies, looks the same, and loosely alike. */
export const DISTANCES = { exact: 2, similar: 6, loose: 10 } as const;

/** The 9x8 greyscale miniature of an image, or null when it can't be read. */
export async function miniature(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const sharp = (await import("sharp")).default;
    const raw = await sharp(Buffer.from(bytes)).rotate().resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" }).greyscale().raw().toBuffer();
    return raw.length === HASH_WIDTH * HASH_HEIGHT ? raw : null;
  } catch {
    return null;
  }
}

export async function hashImage(bytes: Uint8Array): Promise<string | null> {
  const mini = await miniature(bytes);
  return mini ? dHash(mini) : null;
}

export interface HashDeps {
  fetchThumbnail(serverId: string, fileId: string): Promise<{ bytes: Uint8Array } | null>;
  hash(bytes: Uint8Array): Promise<string | null>;
  /** Spends one call of the server's photo budget; false when it is used up for now. */
  spend(serverId: string): Promise<boolean>;
}

async function defaultDeps(): Promise<HashDeps> {
  const { createStorageForServer } = await import("@/lib/storage/server-storage");
  const { spendServerBudget } = await import("@/lib/photos/serve");
  return {
    fetchThumbnail: async (serverId, fileId) => createStorageForServer(serverId).fetchThumbnail?.(fileId) ?? null,
    hash: hashImage,
    spend: spendServerBudget,
  };
}

export interface Progress {
  /** Pictures in the library. */
  total: number;
  /** With a fingerprint. */
  checked: number;
  /** Tried and couldn't be read (tried again after a week). */
  failed: number;
}

export async function hashProgress(ex: Db, libraryId: string): Promise<Progress> {
  const [r] = await ex
    .select({
      total: sql<number>`count(*)::int`,
      checked: sql<number>`count(${titles.photoHash})::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${titles.photoHash} IS NULL AND ${titles.photoHashAt} IS NOT NULL)::int`,
    })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "photo")));
  return r;
}

/**
 * Fingerprints up to `limit` more pictures of a library (those not yet done, and failures older than a week). Gives up early when the server's
 * photo budget runs out or `deadlineMs` passes. Returns how many were done and the progress overall.
 */
export async function hashBatch(ex: Db, args: { libraryId: string; limit: number; deadlineMs?: number; deps?: HashDeps; concurrency?: number; now?: Date }): Promise<{ hashed: number; failed: number; budgetUsedUp: boolean; total: number; checked: number }> {
  const deps = args.deps ?? (await defaultDeps());
  const now = args.now ?? new Date();
  const [lib] = await ex.select({ serverId: libraries.serverId }).from(libraries).where(eq(libraries.id, args.libraryId));
  if (!lib) return { hashed: 0, failed: 0, budgetUsedUp: false, total: 0, checked: 0 };
  const todo = await ex
    .select({ id: titles.id, fileId: mediaFiles.boxFileId })
    .from(titles)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.versionLabel, "")))
    .where(and(eq(titles.libraryId, args.libraryId), eq(titles.kind, "photo"), isNull(titles.photoHash), or(isNull(titles.photoHashAt), lt(titles.photoHashAt, new Date(now.getTime() - RETRY_AFTER_MS)))))
    .orderBy(asc(titles.id))
    .limit(Math.max(1, Math.min(args.limit, 200)));
  let hashed = 0;
  let failed = 0;
  let budgetUsedUp = false;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length || budgetUsedUp || (args.deadlineMs !== undefined && Date.now() > args.deadlineMs)) return;
      const t = todo[i];
      if (!(await deps.spend(lib.serverId))) {
        budgetUsedUp = true;
        return;
      }
      let hash: string | null = null;
      try {
        const thumb = await deps.fetchThumbnail(lib.serverId, t.fileId);
        hash = thumb ? await deps.hash(thumb.bytes) : null;
      } catch {
        hash = null;
      }
      await ex.update(titles).set({ photoHash: isHash(hash) ? hash : null, photoHashAt: now }).where(eq(titles.id, t.id));
      if (isHash(hash)) hashed++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency ?? 4) }, worker));
  const progress = await hashProgress(ex, args.libraryId);
  return { hashed, failed, budgetUsedUp, total: progress.total, checked: progress.checked };
}

export interface DupItem {
  id: string;
  name: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  folderPath: string | null;
  thumbUrl: string;
}
export interface DupGroup {
  /** "exact": the pictures look identical; "similar": alike but not identical (a different crop or edit, or a burst of shots). */
  match: "exact" | "similar";
  /** The photo to keep, unless the admin chooses another. */
  keepId: string;
  items: DupItem[];
}

/** Groups of pictures in a library that look alike, not counting those already hidden. */
export async function duplicateGroups(ex: Db, args: { libraryId: string; maxDistance: number }): Promise<DupGroup[]> {
  const rows = await ex
    .select({
      id: titles.id,
      name: titles.name,
      hash: titles.photoHash,
      sizeBytes: mediaFiles.sizeBytes,
      width: titles.width,
      height: titles.height,
      takenAt: titles.takenAt,
      folderPath: titles.folderPath,
      added: titles.addedAt,
      updated: titles.updatedAt,
    })
    .from(titles)
    .leftJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.versionLabel, "")))
    .where(and(eq(titles.libraryId, args.libraryId), eq(titles.kind, "photo"), isNotNull(titles.photoHash), isNull(titles.duplicateOf)));
  const usable = rows.filter((r): r is typeof r & { hash: string } => isHash(r.hash));
  const groups = groupAlike(usable.map((r) => ({ id: r.id, hash: r.hash })), args.maxDistance);
  const byId = new Map(usable.map((r) => [r.id, r]));
  return groups.map((g) => {
    const members = g.map((m) => byId.get(m.id)!);
    let widest = 0;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) widest = Math.max(widest, distance(members[i].hash, members[j].hash));
    const keep = suggestKeep(members.map((m) => ({ ...m, sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes) })));
    return {
      match: widest <= DISTANCES.exact ? "exact" : "similar",
      keepId: keep.id,
      items: members
        .map((m) => ({
          id: m.id,
          name: m.name,
          sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes),
          width: m.width,
          height: m.height,
          takenAt: m.takenAt?.toISOString() ?? null,
          folderPath: m.folderPath,
          thumbUrl: photoThumbUrl(m.id, thumbVersion({ sizeBytes: m.sizeBytes === null ? undefined : Number(m.sizeBytes), modifiedAt: m.updated, createdAt: m.added })),
        }))
        .sort((a, b) => (a.id === keep.id ? -1 : b.id === keep.id ? 1 : (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))),
    } satisfies DupGroup;
  });
}

export type HideResult = { ok: true; hidden: number } | { ok: false; status: 400 | 404; error: string };

/** Hides copies in favour of the photo kept: all must be pictures of this library, and the one kept is not itself hidden. Favorites move to the one kept. */
export async function hideDuplicates(ex: Db, args: { libraryId: string; keepId: string; hideIds: string[] }): Promise<HideResult> {
  const hideIds = [...new Set(args.hideIds)].filter((id) => id !== args.keepId);
  if (hideIds.length === 0) return { ok: false, status: 400, error: "Choose at least one copy to hide." };
  if (hideIds.length > 200) return { ok: false, status: 400, error: "That is too many at once." };
  const rows = await ex
    .select({ id: titles.id, duplicateOf: titles.duplicateOf })
    .from(titles)
    .where(and(eq(titles.libraryId, args.libraryId), eq(titles.kind, "photo"), inArray(titles.id, [args.keepId, ...hideIds])));
  const keep = rows.find((r) => r.id === args.keepId);
  if (!keep || rows.length !== hideIds.length + 1) return { ok: false, status: 404, error: "Not found" };
  if (keep.duplicateOf) return { ok: false, status: 400, error: "The photo to keep is itself hidden." };
  await ex.update(titles).set({ duplicateOf: args.keepId, updatedAt: new Date() }).where(inArray(titles.id, hideIds));
  // Anything a profile hearted among the hidden copies stays hearted, on the one kept.
  await ex.execute(sql`INSERT INTO photo_favorites (viewer_id, title_id) SELECT DISTINCT f.viewer_id, ${args.keepId}::uuid FROM photo_favorites f WHERE f.title_id IN (${sql.join(hideIds.map((id) => sql`${id}::uuid`), sql`, `)}) ON CONFLICT DO NOTHING`);
  return { ok: true, hidden: hideIds.length };
}

/** Brings hidden copies back. Returns how many were. */
export async function restoreDuplicates(ex: Db, args: { libraryId: string; ids: string[] }): Promise<number> {
  if (args.ids.length === 0) return 0;
  const done = await ex
    .update(titles)
    .set({ duplicateOf: null, updatedAt: new Date() })
    .where(and(eq(titles.libraryId, args.libraryId), eq(titles.kind, "photo"), isNotNull(titles.duplicateOf), inArray(titles.id, args.ids.slice(0, 500))))
    .returning({ id: titles.id });
  return done.length;
}

export interface HiddenItem extends DupItem {
  keptId: string;
  keptName: string | null;
}

/** The copies hidden in a library, with the photo each was hidden in favour of. */
export async function hiddenDuplicates(ex: Db, libraryId: string): Promise<HiddenItem[]> {
  const kept = sql`(SELECT k.name FROM titles k WHERE k.id = ${titles.duplicateOf})`;
  const rows = await ex
    .select({ id: titles.id, name: titles.name, sizeBytes: mediaFiles.sizeBytes, width: titles.width, height: titles.height, takenAt: titles.takenAt, folderPath: titles.folderPath, added: titles.addedAt, updated: titles.updatedAt, keptId: titles.duplicateOf, keptName: sql<string | null>`${kept}` })
    .from(titles)
    .leftJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.versionLabel, "")))
    .where(and(eq(titles.libraryId, libraryId), eq(titles.kind, "photo"), isNotNull(titles.duplicateOf)))
    .orderBy(asc(titles.name))
    .limit(500);
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes),
    width: m.width,
    height: m.height,
    takenAt: m.takenAt?.toISOString() ?? null,
    folderPath: m.folderPath,
    thumbUrl: photoThumbUrl(m.id, thumbVersion({ sizeBytes: m.sizeBytes === null ? undefined : Number(m.sizeBytes), modifiedAt: m.updated, createdAt: m.added })),
    keptId: m.keptId as string,
    keptName: m.keptName,
  }));
}
