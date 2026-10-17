/** Which seasons still need their intro and credits found, and keeping what was found. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, libraries, mediaFiles, seasons, titles } from "@/lib/db/schema";
import type { SkipSegment } from "@/lib/skipdb/client";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface SeasonToDetect {
  showName: string;
  season: number;
  serverId: string;
  episodes: { id: string; number: number; fileId: string; durationSeconds: number }[];
}

/**
 * Seasons of shows whose episodes have not all been listened to yet, with the episodes that can be (one ordinary, fully read file each;
 * a combined or multi-part file is left out, and so is a file with no length). Without `force`, a season where every listenable episode has
 * been done is not offered again.
 */
export async function seasonsToDetect(ex: Db, opts: { show?: string; season?: number; force?: boolean } = {}): Promise<SeasonToDetect[]> {
  const rows = await ex
    .select({
      showName: titles.name,
      season: seasons.number,
      serverId: libraries.serverId,
      id: episodes.id,
      number: episodes.number,
      fileId: mediaFiles.boxFileId,
      durationSeconds: mediaFiles.durationSeconds,
      detectedAt: mediaFiles.skipDetectedAt,
      parts: sql<number>`(SELECT count(*)::int FROM media_files p WHERE p.owner_kind = 'episode' AND p.owner_id = ${episodes.id} AND p.version_label = '' AND p.variant_of_media_file_id IS NULL)`,
    })
    .from(mediaFiles)
    .innerJoin(episodes, and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id)))
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .innerJoin(titles, eq(titles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(eq(titles.kind, "show"), eq(libraries.kind, "shows"), eq(mediaFiles.versionLabel, ""), isNull(mediaFiles.variantOfMediaFileId), sql`${mediaFiles.durationSeconds} IS NOT NULL`, sql`${mediaFiles.container} IN ('mp4','m4v','mov')`))
    .orderBy(asc(titles.name), asc(seasons.number), asc(episodes.number));
  const bySeason = new Map<string, { s: SeasonToDetect; pending: number }>();
  for (const r of rows) {
    if (r.parts !== 1 || r.durationSeconds === null) continue;
    if (opts.show && !r.showName.toLowerCase().includes(opts.show.toLowerCase())) continue;
    if (opts.season !== undefined && r.season !== opts.season) continue;
    const key = `${r.serverId}\0${r.showName}\0${r.season}`;
    const entry = bySeason.get(key) ?? { s: { showName: r.showName, season: r.season, serverId: r.serverId, episodes: [] }, pending: 0 };
    entry.s.episodes.push({ id: r.id, number: r.number, fileId: r.fileId, durationSeconds: r.durationSeconds });
    if (r.detectedAt === null) entry.pending++;
    bySeason.set(key, entry);
  }
  return [...bySeason.values()].filter((e) => opts.force || e.pending > 0).map((e) => e.s);
}

/** Keeps what was found for an episode on every file it has (the other versions share its timeline); an empty list notes "listened, found nothing". */
export async function saveDetected(ex: Db, episodeId: string, marks: readonly SkipSegment[], now = new Date()): Promise<void> {
  await ex
    .update(mediaFiles)
    .set({ detectedSkipMarks: marks.length > 0 ? marks.map((m) => ({ kind: m.kind, startSeconds: m.startSeconds, endSeconds: m.endSeconds })) : null, skipDetectedAt: now })
    .where(and(eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, [episodeId])));
}
