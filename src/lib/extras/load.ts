import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mediaFiles, titleExtras } from "@/lib/db/schema";
import { isBrowserPlayableMedia } from "@/lib/scan/codec-support";
import { EXTRA_CATEGORIES, type ExtraCategory } from "./categories";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface ExtraItem {
  id: string;
  name: string;
  category: ExtraCategory;
  durationSeconds: number;
}

/** A movie's extras that are ready to play (their length is known, and in a format browsers play), grouped by type in the usual order, each group A to Z. */
export async function loadTitleExtras(ex: Db, titleId: string): Promise<{ category: ExtraCategory; items: ExtraItem[] }[]> {
  const rows = await ex
    .select({ id: titleExtras.id, name: titleExtras.name, category: titleExtras.category, durationSeconds: mediaFiles.durationSeconds, videoCodec: mediaFiles.videoCodec, audioCodec: mediaFiles.audioCodec })
    .from(titleExtras)
    .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.ownerId, titleExtras.id), eq(mediaFiles.partIndex, 0)))
    .where(eq(titleExtras.titleId, titleId))
    .orderBy(asc(titleExtras.name), asc(titleExtras.id));
  const ready = rows.filter((r): r is typeof r & { durationSeconds: number } => r.durationSeconds != null && isBrowserPlayableMedia(r.videoCodec, r.audioCodec));
  return EXTRA_CATEGORIES.map((category) => ({ category, items: ready.filter((r) => r.category === category) })).filter((g) => g.items.length > 0);
}
