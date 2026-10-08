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
import { listFolder, normalizeFolderPath, type FolderPage } from "@/lib/libraries/folder-browse";
import type { LibraryKind } from "@/lib/db/schema";
import { isPhotoLibraryKind, libraryRemembersProgress, tvBrowseStyle, TV_LISTEN_KINDS, TV_WATCH_KINDS, type TvBrowseStyle } from "@/lib/libraries/profile";
import { getAlbum } from "@/lib/music/browse";
import { listTimeline, loadPhoto, photoNeighbors, type NeighborScope, type TimelineCursor } from "@/lib/photos/timeline";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface TvScope {
  actor: LibraryActor;
  viewer: AccessProfile;
  viewerId: string;
}

/** Whether a kind of library has a TV interface (see tvBrowseStyle for how each is laid out). */
const supportedKind = (kind: string): boolean => tvBrowseStyle(kind as LibraryKind) !== null;

/** One library this profile may open on TV, with how it is laid out there, or null (hidden, missing, or a kind the TV doesn't show). */
export async function tvLibrary(ex: Db, scope: TvScope, libraryId: string) {
  const [library] = await ex
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), libraryVisible(ex, scope.actor)))
    .limit(1);
  const style = library ? tvBrowseStyle(library.kind) : null;
  return library && style ? { ...library, style } : null;
}
const styleIs = (library: { style: TvBrowseStyle } | null, style: TvBrowseStyle) => !!library && library.style === style;

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
  /** What opens it: a movie or episode on the video player, a book or audio file on the audio player. */
  kind: "title" | "episode" | "listen";
  id: string;
  name: string;
  meta: string | null;
  posterUrl: string | null;
  progress: number;
}

/**
 * Things the profile has started and not finished, most recent first, in libraries it may see: movies, videos and episodes to watch;
 * audiobooks and audio files to listen to. (Music and photo clips never record progress, so they never appear.)
 */
export async function continueWatching(ex: Db, scope: TvScope, limit = 12): Promise<{ watching: ContinueItem[]; listening: ContinueItem[] }> {
  const states = await ex
    .select()
    .from(watchState)
    .where(and(eq(watchState.viewerId, scope.viewerId), eq(watchState.finished, false), gt(watchState.positionSeconds, 0)))
    .orderBy(desc(watchState.updatedAt))
    .limit(80);
  const titleIds = states.filter((s) => s.ownerKind === "title").map((s) => s.ownerId);
  const episodeIds = states.filter((s) => s.ownerKind === "episode").map((s) => s.ownerId);

  const visible = (libraryKinds: readonly LibraryKind[]) => and(inArray(libraries.kind, [...libraryKinds]), libraryVisible(ex, scope.actor));
  const movies = titleIds.length
    ? await ex
        .select({ id: titles.id, name: titles.name, year: titles.year, posterUrl: titles.posterUrl })
        .from(titles)
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(titles.id, titleIds), eq(titles.kind, "movie"), visible(TV_WATCH_KINDS), contentFilter(scope.viewer, titles.ratingAges)))
    : [];
  const audio = titleIds.length
    ? await ex
        .select({ id: titles.id, name: titles.name, authors: titles.authors, posterUrl: titles.posterUrl })
        .from(titles)
        .innerJoin(libraries, eq(titles.libraryId, libraries.id))
        .where(and(inArray(titles.id, titleIds), eq(titles.kind, "audiobook"), visible(TV_LISTEN_KINDS.filter(libraryRemembersProgress)), contentFilter(scope.viewer, titles.ratingAges)))
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

  const watching: ContinueItem[] = [];
  const listening: ContinueItem[] = [];
  for (const s of states) {
    const progress = s.durationSeconds ? Math.min(1, s.positionSeconds / s.durationSeconds) : 0;
    if (s.ownerKind === "title") {
      const m = movies.find((x) => x.id === s.ownerId);
      if (m && watching.length < limit) watching.push({ kind: "title", id: m.id, name: m.name, meta: m.year ? String(m.year) : null, posterUrl: m.posterUrl, progress });
      const a = audio.find((x) => x.id === s.ownerId);
      if (a && listening.length < limit) listening.push({ kind: "listen", id: a.id, name: a.name, meta: a.authors?.join(", ") || null, posterUrl: a.posterUrl, progress });
    } else {
      const e = eps.find((x) => x.id === s.ownerId);
      if (e && watching.length < limit) watching.push({ kind: "episode", id: e.id, name: e.show, meta: `S${e.season} · E${e.number}${e.name ? ` · ${e.name}` : ""}`, posterUrl: e.posterUrl, progress });
    }
  }
  return { watching, listening };
}

export interface ListedTitle {
  id: string;
  kind: "movie" | "show" | "audiobook";
  name: string;
  year: number | null;
  posterUrl: string | null;
  /** Audiobooks: who wrote it. */
  authors: string[] | null;
}

/** One page of a movies, TV shows or audiobooks library, by name. Null when the library isn't one this profile can open that way on TV. */
export async function libraryTitles(ex: Db, scope: TvScope, libraryId: string, page: number) {
  const library = await tvLibrary(ex, scope, libraryId);
  if (!styleIs(library, "grid")) return null;
  const offset = (Math.max(1, Math.floor(page)) - 1) * PAGE_SIZE;
  const rows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl, authors: titles.authors })
    .from(titles)
    .where(and(eq(titles.libraryId, libraryId), inArray(titles.kind, ["movie", "show", "audiobook"]), contentFilter(scope.viewer, titles.ratingAges)))
    .orderBy(sql`lower(${titles.name})`, asc(titles.id))
    .limit(PAGE_SIZE + 1)
    .offset(offset);
  return {
    library: library!,
    items: rows.slice(0, PAGE_SIZE) as ListedTitle[],
    hasMore: rows.length > PAGE_SIZE,
  };
}

async function visibleTitle(ex: Db, scope: TvScope, id: string, kind: "movie" | "show") {
  const [row] = await ex
    .select({ title: titles, libraryId: libraries.id, libraryName: libraries.name, libraryKind: libraries.kind })
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
  back: { kind: "title"; id: string } | { kind: "show"; id: string; season: number } | { kind: "folder"; libraryId: string; path: string } | { kind: "photo"; id: string };
  next: { kind: "episode"; id: string } | null;
}

/** What a watch page needs: names, where Back goes and the next episode, only for something this profile may see. */
export async function watchInfo(ex: Db, scope: TvScope, ownerKind: "title" | "episode", id: string): Promise<WatchInfo | null> {
  if (ownerKind === "title") {
    const row = await visibleTitle(ex, scope, id, "movie");
    if (!row) return null;
    // A clip in a photo library goes back to the picture viewer, one in a video library to its folder; a movie to its page.
    const back: WatchInfo["back"] = isPhotoLibraryKind(row.libraryKind) ? { kind: "photo", id } : tvBrowseStyle(row.libraryKind) === "folders" ? { kind: "folder", libraryId: row.libraryId, path: row.title.folderPath ?? "" } : { kind: "title", id };
    return { ownerKind, ownerId: id, title: row.title.name, subtitle: row.title.year ? String(row.title.year) : null, back, next: null };
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

// ── Folder libraries (video, audio, photos) ─────────────────────────────────────

export const TV_FOLDER_PAGE = 24;

/** A cursor in a URL: the list key and id of the last item shown, or null when it isn't one. */
export function parseFolderCursor(raw: string | null): { key: string; id: string } | null | "bad" {
  if (!raw) return null;
  const sep = raw.lastIndexOf("~");
  const key = sep > 0 ? raw.slice(0, sep) : "";
  const id = sep > 0 ? raw.slice(sep + 1) : "";
  return /^[0-9a-f-]{36}$/i.test(id) && key.length <= 600 ? { key, id } : "bad";
}
export const folderCursorParam = (c: { key: string; id: string }): string => `${c.key}~${c.id}`;

/** One level of a video or audio library: its folders and one page of the files directly inside. Null when it isn't visible to this profile. */
export async function folderLevel(ex: Db, scope: TvScope, libraryId: string, rawPath: string | null, after: { key: string; id: string } | null) {
  const library = await tvLibrary(ex, scope, libraryId);
  const path = normalizeFolderPath(rawPath);
  if (!library || path === null || library.style !== "folders") return null;
  const page: FolderPage | null = await listFolder(ex, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, libraryId, path, limit: TV_FOLDER_PAGE, after });
  return page ? { library, path, ...page } : null;
}

// ── Photos ───────────────────────────────────────────────────────────────────────

export const TV_PHOTO_PAGE = 30;

/** One page of a photo library, newest first. Null when the profile can't see such a library. */
export async function photoPage(ex: Db, scope: TvScope, libraryId: string, after: TimelineCursor | null) {
  const library = await tvLibrary(ex, scope, libraryId);
  if (!library || library.style !== "timeline") return null;
  const page = await listTimeline(ex, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, libraryId, after, limit: TV_PHOTO_PAGE });
  return page ? { library, ...page } : null;
}

/** A picture (or a clip) with the items either side of it, in the order the timeline shows them. Null when it isn't visible. */
export async function photoView(ex: Db, scope: TvScope, id: string, scopeKind: NeighborScope) {
  const photo = await loadPhoto(ex, { actor: scope.actor, viewer: scope.viewer, viewerId: scope.viewerId, id });
  if (!photo) return null;
  const neighbors = await photoNeighbors(ex, { actor: scope.actor, viewer: scope.viewer, photo, scope: scopeKind });
  return { photo, ...neighbors };
}

// ── Audiobooks, audio files and songs ───────────────────────────────────────────────

/** An audiobook, with where the profile left off, or null. */
export async function bookDetail(ex: Db, scope: TvScope, id: string) {
  const [row] = await ex
    .select({ title: titles, libraryId: libraries.id, libraryName: libraries.name })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(titles.kind, "audiobook"), eq(libraries.kind, "audiobooks"), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    .limit(1);
  if (!row) return null;
  const [state] = await stateFor(ex, scope.viewerId, "title", [id]);
  const resumable = !!state && !state.finished && state.positionSeconds > 0;
  return { ...row, resume: resumable ? { positionSeconds: state.positionSeconds, durationSeconds: state.durationSeconds } : null };
}

export interface ListenInfo {
  id: string;
  name: string;
  subtitle: string | null;
  coverUrl: string | null;
  libraryKind: LibraryKind;
  /** Whether the profile's place is kept for this kind of library (it isn't for songs). */
  remembers: boolean;
  /** Where Back goes, relative to the TV's base path. */
  back: string;
  /** The next song of an album, relative to the TV's base path. */
  next: string | null;
}

/** What a listening page needs: the names, where Back goes and the next song, only for something this profile may see. */
export async function listenInfo(ex: Db, scope: TvScope, id: string): Promise<ListenInfo | null> {
  const [row] = await ex
    .select({ title: titles, libraryId: libraries.id, libraryKind: libraries.kind })
    .from(titles)
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(and(eq(titles.id, id), eq(titles.kind, "audiobook"), inArray(libraries.kind, [...TV_LISTEN_KINDS]), libraryVisible(ex, scope.actor), contentFilter(scope.viewer, titles.ratingAges)))
    .limit(1);
  if (!row) return null;
  const t = row.title;
  const libraryKind = row.libraryKind;
  const by = (t.authors ?? []).join(", ") || t.folderAuthor || null;
  let back = `/library/${row.libraryId}`;
  let next: string | null = null;
  if (tvBrowseStyle(libraryKind) === "grid") back = `/book/${t.id}`;
  else if (tvBrowseStyle(libraryKind) === "folders") back = `/library/${row.libraryId}${t.folderPath ? `?path=${encodeURIComponent(t.folderPath)}` : ""}`;
  else if (t.albumId) {
    back = `/album/${t.albumId}`;
    const album = await getAlbum(ex, { actor: scope.actor, viewer: scope.viewer, albumId: t.albumId });
    const at = album ? album.tracks.findIndex((x) => x.id === t.id) : -1;
    const following = album && at >= 0 ? album.tracks[at + 1] : undefined;
    if (following) next = `/listen/${following.id}`;
  }
  return { id: t.id, name: t.name, subtitle: by, coverUrl: t.posterUrl, libraryKind, remembers: libraryRemembersProgress(libraryKind), back, next };
}
