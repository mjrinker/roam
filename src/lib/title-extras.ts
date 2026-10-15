/** What a movie's page shows besides its details, as data: parental guide, chapters, extras and cast. Used by the TV pages and the API. */
import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { severityAtLeast, type ContentFilterPrefs, type FilterCategory, type FilterSeverity } from "@/lib/content-filter/categories";
import { guideFromCues } from "@/lib/content-filter/playback";
import { cuesFromRows } from "@/lib/content-filter/rows";
import { chaptersFromRows } from "@/lib/chapters/rows";
import { loadTitleCast } from "@/lib/cast/queries";
import { mediaFiles } from "@/lib/db/schema";
import { loadDddForMovie } from "@/lib/ddd/page";
import { mergeGuideLines } from "@/lib/ddd/transform";
import { loadTitleExtras } from "@/lib/extras/load";
import { defaultVersionRows } from "@/lib/player/versions";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface MovieExtras {
  guide: {
    lines: { category: FilterCategory; /** null for a community report (it has no strength) */ severity: FilterSeverity | null; scenes: number; seconds: number; source: "file" | "community"; skippedForYou: boolean }[];
    reports: { topic: string; yes: number; no: number }[];
    /** True when any of it came from Does the Dog Die: its credit and "unverified" reminder must be shown with it. */
    fromCommunity: boolean;
  };
  chapters: { title: string; startSeconds: number }[];
  extras: { category: string; items: { id: string; name: string; durationSeconds: number }[] }[];
  cast: { name: string; character: string | null; photoUrl: string | null }[];
}

export async function loadMovieExtras(ex: Db, ctx: { serverId: string; titleId: string; title: { imdbId: string | null; tmdbId: number | null }; filterPrefs: ContentFilterPrefs; maxCast?: number }): Promise<MovieExtras> {
  const segments = defaultVersionRows(await ex.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, ctx.titleId))).orderBy(asc(mediaFiles.partIndex)));
  const ddd = await loadDddForMovie(ex, ctx.serverId, ctx.title, ctx.filterPrefs);
  const lines = mergeGuideLines(guideFromCues(cuesFromRows(segments)), ddd.lines);
  const chapters = segments.length > 0 && segments.every((s) => s.durationSeconds != null) ? chaptersFromRows(segments) : [];
  const cast = (await loadTitleCast(ex, ctx.titleId)).slice(0, ctx.maxCast ?? 10);
  return {
    guide: {
      lines: lines.map((l) => {
        const threshold = ctx.filterPrefs[l.category];
        const community = l.source === "community";
        return { category: l.category, severity: community ? null : l.severity, scenes: l.scenes, seconds: l.seconds, source: community ? "community" : "file", skippedForYou: threshold !== undefined && severityAtLeast(l.severity, threshold) };
      }),
      reports: ddd.reports.map((r) => ({ topic: r.topicName, yes: r.yes, no: r.no })),
      fromCommunity: ddd.reports.length > 0 || lines.some((l) => l.source === "community"),
    },
    chapters: chapters.length > 1 ? chapters : [],
    extras: (await loadTitleExtras(ex, ctx.titleId)).map((g) => ({ category: g.category, items: g.items.map((i) => ({ id: i.id, name: i.name, durationSeconds: i.durationSeconds })) })),
    cast: cast.map((c) => ({ name: c.name, character: c.character, photoUrl: c.photoUrl })),
  };
}
