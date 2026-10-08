/**
 * What the TV pages show, read with the same rules as the rest of Roam: a library is visible only to those it is shared with, a
 * profile's age limit hides titles before anything is counted or listed, and a title that is hidden looks exactly like one that
 * does not exist (the callers answer the same "not found"). Movies and TV shows only for now; other kinds of library are counted
 * so the home screen can say they are not on TV yet.
 */
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { episodes, libraries, seasons, titles, watchState } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface TvScope {
  actor: LibraryActor;
  viewer: AccessProfile;
  viewerId: string;
}

/** The kinds of library that have a TV interface. */
export const TV_LIBRARY_KINDS = ["movies", "shows"] as const;
const supportedKind = (kind: string) => (TV_LIBRARY_KINDS as readonly string[]).includes(kind);

export const PAGE_SIZE = 24;

export async function tvLibraries(ex: Db, scope: TvScope) {
  const all = await ex
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(libraryVisible(ex, scope.actor))
    .orderBy(asc(libraries.name));
  return { supported: all.filter((l) => supportedKind(l.kind)), unsupported: all.filter((l) => !supportedKind(l.kind)).length };
}

export interface ContinueItem {
  kind: "title" | "episode";
  id: string;
  name: string;
  meta: string | null;
  posterUrl: string | null;
  progress: number;
}

/** Things the profile has started and not finished, most recent first: movies and episodes in libraries it may see. */
export async function continueWatching(ex: Db, scope: TvScope, limit = 12): Promise<ContinueItem[]> {
  const states = await ex
    .select()
    .from(watchState)
    .where(and(eq(watchState.viewerId, scope.viewerId), eq(watchState.finished, false), gt(watchState.positionSeconds, 0)))
    .orderBy(desc(watchState.updatedAt))
    .limit(60);
  const titleIds = states.filter((s) => s.ownerKind === "title").map((s) => s.ownerId);
  const episodeIds = states.filter((s) => s.ownerKind === "episode").map((s) => s.ownerId);

  const movies = titleIds.length
    ? await ex
        .select({ id: titles.id, name: titles.name, year: titles.year, posterUrl: titles.posterUrl })
        .from(titles)
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(titles.id, titleIds), eq(titles.kind, "movie"), eq(libraries.kind, "movies"), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    : [];
  const eps = episodeIds.length
    ? await ex
        .select({ id: episodes.id, number: episodes.number, name: episodes.name, season: seasons.number, show: titles.name, posterUrl: titles.posterUrl })
        .from(episodes)
        .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
        .innerJoin(titles, eq(seasons.titleId, titles.id))
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(episodes.id, episodeIds), eq(libraries.kind, "shows"), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    : [];

  const out: ContinueItem[] = [];
  for (const s of states) {
    const progress = s.durationSeconds ? Math.min(1, s.positionSeconds / s.durationSeconds) : 0;
    if (s.ownerKind === "title") {
      const m = movies.find((x) => x.id === s.ownerId);
      if (m) out.push({ kind: "title", id: m.id, name: m.name, meta: m.year ? String(m.year) : null, posterUrl: m.posterUrl, progress });
    } else {
      const e = eps.find((x) => x.id === s.ownerId);
      if (e) out.push({ kind: "episode", id: e.id, name: e.show, meta: `S${e.season} · E${e.number}${e.name ? ` · ${e.name}` : ""}`, posterUrl: e.posterUrl, progress });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export interface ListedTitle {
  id: string;
  kind: "movie" | "show";
  name: string;
  year: number | null;
  posterUrl: string | null;
}

/** One page of a movies or TV shows library, by name. Null when the library isn't one this profile can open on TV. */
export async function libraryTitles(ex: Db, scope: TvScope, libraryId: string, page: number) {
  const [library] = await ex
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), libraryVisible(ex, scope.actor)))
    .limit(1);
  if (!library || !supportedKind(library.kind)) return null;
  const offset = (Math.max(1, Math.floor(page)) - 1) * PAGE_SIZE;
  const rows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), inArray(titles.kind, ["movie", "show"]), contentFilter(scope.viewer, titles.ratingAges)))
    .orderBy(sql`lower(${titles.name})`, asc(titles.id))
    .limit(PAGE_SIZE + 1)
    .offset(offset);
  return {
    library,
    items: rows.slice(0, PAGE_SIZE) as ListedTitle[],
    hasMore: rows.length > PAGE_SIZE,
  };
}

async function visibleTitle(ex: Db, scope: TvScope, id: string, kind: "movie" | "show") {
  const [row] = await ex
    .select({ title: titles, libraryId: libraries.id, libraryName: libraries.name })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(titles.kind, kind), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    .limit(1);
  return row ?? null;
}

const stateFor = async (ex: Db, viewerId: string, ownerKind: "title" | "episode", ids: string[]) =>
  ids.length ? ex.select().from(watchState).where(and(eq(watchState.viewerId, viewerId), eq(watchState.ownerKind, ownerKind), inArray(watchState.ownerId, ids))) : [];

export async function movieDetail(ex: Db, scope: TvScope, id: string) {
  const row = await visibleTitle(ex, scope, id, "movie");
  if (!row) return null;
  const [state] = await stateFor(ex, scope.viewerId, "title", [id]);
  const resumable = !!state && !state.finished && state.positionSeconds > 0;
  return { ...row, resume: resumable ? { positionSeconds: state.positionSeconds, durationSeconds: state.durationSeconds } : null };
}

export async function showDetail(ex: Db, scope: TvScope, id: string, seasonNumber?: number) {
  const row = await visibleTitle(ex, scope, id, "show");
  if (!row) return null;
  const allSeasons = await ex.select({ id: seasons.id, number: seasons.number }).from(seasons).where(eq(seasons.titleId, id)).orderBy(asc(seasons.number));
  const current = allSeasons.find((s) => s.number === seasonNumber) ?? allSeasons[0] ?? null;
  const eps = current ? await ex.select().from(episodes).where(eq(episodes.seasonId, current.id)).orderBy(asc(episodes.number)) : [];
  const states = await stateFor(ex, scope.viewerId, "episode", eps.map((e) => e.id));
  return {
    ...row,
    seasons: allSeasons.map((s) => s.number),
    currentSeason: current?.number ?? null,
    episodes: eps.map((e) => {
      const s = states.find((x) => x.ownerId === e.id);
      return { id: e.id, number: e.number, name: e.name, watched: !!s?.finished, inProgress: !!s && !s.finished && s.positionSeconds > 0 };
    }),
  };
}

export interface WatchInfo {
  ownerKind: "title" | "episode";
  ownerId: string;
  title: string;
  subtitle: string | null;
  /** Where Back goes, relative to the TV's base path. */
  back: { kind: "title" | "show"; id: string; season?: number };
  next: { kind: "episode"; id: string } | null;
}

/** What a watch page needs: names, where Back goes and the next episode, only for something this profile may see. */
export async function watchInfo(ex: Db, scope: TvScope, ownerKind: "title" | "episode", id: string): Promise<WatchInfo | null> {
  if (ownerKind === "title") {
    const row = await visibleTitle(ex, scope, id, "movie");
    return row ? { ownerKind, ownerId: id, title: row.title.name, subtitle: row.title.year ? String(row.title.year) : null, back: { kind: "title", id }, next: null } : null;
  }
  const [row] = await ex
    .select({ episode: episodes, season: seasons, show: titles })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(episodes.id, id), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    .limit(1);
  if (!row) return null;
  const [nextInSeason] = await ex
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.seasonId, row.season.id), gt(episodes.number, row.episode.number)))
    .orderBy(asc(episodes.number))
    .limit(1);
  let nextId = nextInSeason?.id ?? null;
  if (!nextId) {
    const [nextSeason] = await ex.select({ id: seasons.id }).from(seasons).where(and(eq(seasons.titleId, row.show.id), gt(seasons.number, row.season.number))).orderBy(asc(seasons.number)).limit(1);
    if (nextSeason) nextId = (await ex.select({ id: episodes.id }).from(episodes).where(eq(episodes.seasonId, nextSeason.id)).orderBy(asc(episodes.number)).limit(1))[0]?.id ?? null;
  }
  return {
    ownerKind,
    ownerId: id,
    title: row.show.name,
    subtitle: `S${row.season.number} · E${row.episode.number}${row.episode.name ? ` · ${row.episode.name}` : ""}`,
    back: { kind: "show", id: row.show.id, season: row.season.number },
    next: nextId ? { kind: "episode", id: nextId } : null,
  };
}
