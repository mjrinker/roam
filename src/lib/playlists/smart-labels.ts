/**
 * On a smart playlist, the value each item is ordered by, in a few words ("1h 40m" when ordered by duration), so the order can be seen.
 * Values that belong to the owner (their ratings, when they watched) are shown only to the owner; everything else is public to the server.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { episodes, libraries, playlists, seasons, titles } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { displayCertification } from "@/lib/content/ratings";
import { formatRuntime } from "@/lib/format";
import type { Executor } from "./executor";
import { averageOfSubject, heightOf, runtimeOf, smartRulesSchema, type SmartRules, type Subject } from "./smart";
import { starsText } from "@/lib/ratings/stars";

export interface SortValues {
  runtime: number | null;
  mine: number | null;
  year: number | null;
  added: Date | null;
  watchedAt: Date | null;
  genre: string | null;
  imdb: number | null;
  rottenTomatoes: number | null;
  average: { halfStars: number; count: number } | null;
  certification: string | null;
  height: number | null;
}

const date = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const resolution = (h: number) => (h >= 2160 ? "4K" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : `${h}p`);

/** The words for one item under one sort, or null when it has no such value (or the viewer may not see it). */
export function formatSortLabel(sort: SmartRules["sort"], v: SortValues, viewerIsOwner: boolean): string | null {
  switch (sort) {
    case "longest":
    case "shortest":
      return formatRuntime(v.runtime);
    case "rating":
    case "ratingLowest":
      return viewerIsOwner && v.mine ? `★ ${starsText(v.mine)}` : null;
    case "newest":
    case "oldest":
      return v.year ? String(v.year) : null;
    case "added":
    case "addedOldest":
      return v.added ? `Added ${date(v.added)}` : null;
    case "watchedRecently":
    case "watchedLongAgo":
      return viewerIsOwner ? (v.watchedAt ? `Watched ${date(v.watchedAt)}` : "Not watched") : null;
    case "genre":
      return v.genre;
    case "imdb":
      return v.imdb ? `IMDb ${v.imdb}` : null;
    case "rottenTomatoes":
      return v.rottenTomatoes !== null ? `${v.rottenTomatoes}% on Rotten Tomatoes` : null;
    case "average":
      return v.average ? `★ ${starsText(Math.round(v.average.halfStars))} on this server` : null;
    case "contentRating":
      return v.certification;
    case "quality":
      return v.height ? resolution(v.height) : null;
    default:
      return null; // by name, or at random: nothing to show
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const when = (v: unknown): Date | null => (v ? new Date(v as string) : null);

/** The sort value of the given items of a smart playlist, keyed `t:<titleId>` / `e:<episodeId>` (empty for an ordinary one or a sort with nothing to show). */
export async function smartSortLabels(ex: Executor, args: { playlistId: string; viewerId?: string; lib: LibraryActor; viewer: AccessProfile; items: { titleId: string | null; episodeId: string | null }[] }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [pl] = await ex.select({ rules: playlists.smartRules, owner: playlists.ownerViewerId }).from(playlists).where(eq(playlists.id, args.playlistId));
  if (!pl?.rules) return out;
  const parsed = smartRulesSchema.safeParse(pl.rules);
  if (!parsed.success || parsed.data.sort === "title" || parsed.data.sort === "titleDesc" || parsed.data.sort === "random") return out;
  const sort = parsed.data.sort;
  const isOwner = !!args.viewerId && args.viewerId === pl.owner;
  const owner = pl.owner ?? "00000000-0000-0000-0000-000000000000";
  const country = args.viewer.locale.split("-")[1]?.toUpperCase() ?? "US";
  const certificationOf = (certs: Record<string, string> | null) => displayCertification(certs, country);

  const titleIds = args.items.flatMap((i) => (i.titleId ? [i.titleId] : []));
  if (titleIds.length) {
    const id = sql`${titles.id}`;
    const subject: Subject = { kind: "title", id, titleId: id, name: sql`${titles.name}`, ratingAges: sql`${titles.ratingAges}`, imdb: sql`${titles.imdbRating}`, rottenTomatoes: sql`${titles.rottenTomatoesScore}`, watchedAt: sql`NULL`, isShow: true };
    const fileSubject: Subject = { ...subject, isShow: false };
    const rows = await ex
      .select({
        id: titles.id,
        kind: titles.kind,
        year: titles.year,
        added: titles.addedAt,
        genres: titles.genres,
        imdb: titles.imdbRating,
        rt: titles.rottenTomatoesScore,
        certs: titles.certifications,
        runtime: sql<number | null>`${runtimeOf("title", sql`${titles.runtimeSeconds}`, id)}`,
        mine: sql<number | null>`(SELECT r.half_stars FROM ratings r WHERE r.viewer_id = ${owner} AND r.owner_kind = 'title' AND r.owner_id = ${id})`,
        watchedAt: sql<Date | null>`CASE WHEN ${titles.kind} = 'show'
          THEN (SELECT max(w.updated_at) FROM watch_state w JOIN episodes e ON e.id = w.owner_id JOIN seasons sn ON sn.id = e.season_id WHERE w.viewer_id = ${owner} AND w.owner_kind = 'episode' AND sn.title_id = ${id})
          ELSE (SELECT max(w.updated_at) FROM watch_state w WHERE w.viewer_id = ${owner} AND w.owner_kind = 'title' AND w.owner_id = ${id}) END`,
        average: sql<number | null>`${averageOfSubject(subject)}`,
        averageCount: sql<number>`(SELECT count(*)::int FROM ratings r WHERE r.owner_kind = 'title' AND r.owner_id = ${id})`,
        height: sql<number | null>`CASE WHEN ${titles.kind} = 'show' THEN ${heightOf(subject)} ELSE ${heightOf(fileSubject)} END`,
      })
      .from(titles)
      .innerJoin(libraries, eq(libraries.id, titles.libraryId))
      .where(and(inArray(titles.id, titleIds), libraryVisible(ex, args.lib), contentFilter(args.viewer, titles.ratingAges)));
    for (const r of rows) {
      const label = formatSortLabel(sort, {
        runtime: r.kind === "show" ? null : num(r.runtime),
        mine: num(r.mine),
        year: r.year,
        added: r.added,
        watchedAt: when(r.watchedAt),
        genre: [...(r.genres ?? [])].sort()[0] ?? null,
        imdb: r.imdb,
        rottenTomatoes: r.rt,
        average: r.average === null ? null : { halfStars: Number(r.average), count: r.averageCount },
        certification: certificationOf(r.certs),
        height: num(r.height),
      }, isOwner);
      if (label) out.set(`t:${r.id}`, label);
    }
  }

  const episodeIds = args.items.flatMap((i) => (i.episodeId ? [i.episodeId] : []));
  if (episodeIds.length) {
    const id = sql`${episodes.id}`;
    const subject: Subject = { kind: "episode", id, titleId: sql`${titles.id}`, name: sql`${titles.name}`, ratingAges: sql`${titles.ratingAges}`, imdb: sql`${titles.imdbRating}`, rottenTomatoes: sql`${titles.rottenTomatoesScore}`, watchedAt: sql`NULL` };
    const rows = await ex
      .select({
        id: episodes.id,
        year: titles.year,
        added: titles.addedAt,
        genres: titles.genres,
        imdb: titles.imdbRating,
        rt: titles.rottenTomatoesScore,
        certs: titles.certifications,
        runtime: sql<number | null>`${runtimeOf("episode", sql`${episodes.runtimeSeconds}`, id)}`,
        mine: sql<number | null>`(SELECT r.half_stars FROM ratings r WHERE r.viewer_id = ${owner} AND r.owner_kind = 'episode' AND r.owner_id = ${id})`,
        watchedAt: sql<Date | null>`(SELECT max(w.updated_at) FROM watch_state w WHERE w.viewer_id = ${owner} AND w.owner_kind = 'episode' AND w.owner_id = ${id})`,
        average: sql<number | null>`${averageOfSubject(subject)}`,
        averageCount: sql<number>`(SELECT count(*)::int FROM ratings r WHERE r.owner_kind = 'episode' AND r.owner_id = ${id})`,
        height: sql<number | null>`${heightOf(subject)}`,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .innerJoin(titles, eq(titles.id, seasons.titleId))
      .innerJoin(libraries, eq(libraries.id, titles.libraryId))
      .where(and(inArray(episodes.id, episodeIds), libraryVisible(ex, args.lib), contentFilter(args.viewer, titles.ratingAges)));
    for (const r of rows) {
      const label = formatSortLabel(sort, {
        runtime: num(r.runtime),
        mine: num(r.mine),
        year: r.year,
        added: r.added,
        watchedAt: when(r.watchedAt),
        genre: [...(r.genres ?? [])].sort()[0] ?? null,
        imdb: r.imdb,
        rottenTomatoes: r.rt,
        average: r.average === null ? null : { halfStars: Number(r.average), count: r.averageCount },
        certification: certificationOf(r.certs),
        height: num(r.height),
      }, isOwner);
      if (label) out.set(`e:${r.id}`, label);
    }
  }
  return out;
}
