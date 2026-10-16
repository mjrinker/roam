/**
 * Smart playlists: a playlist made by rules ("unwatched comedies from the 90s I rated 4 stars or more") that fills itself. The rules are
 * evaluated for the playlist's owner (their ratings, their watch history, what they may see) and the result is kept as the playlist's items
 * (so playing, queueing, sharing and the apps all work as for any playlist), brought up to date whenever the playlist is opened after a while.
 * Nobody edits the items of a smart playlist by hand; change the rules instead.
 */
import { hasPlayableFile } from "@/lib/content/playable";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { LibraryKind } from "@/lib/db/schema";
import { episodes, libraries, playlistItems, playlists, seasons, serverMembers, titles, viewers } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { countryFromLocale } from "@/lib/content/ratings";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { SONG_LIBRARY_KINDS } from "@/lib/libraries/profile";
import type { Executor } from "./executor";
import { SMART_MAX_LIMIT, SMART_MAX_SORTS } from "./smart-words";
import { POSITION_GAP } from "./position";

/** The kinds of library a smart playlist can draw from. */
export const SMART_LIBRARY_KINDS = ["movies", "shows", "music", "audio", "audiobooks"] as const satisfies readonly LibraryKind[];
export type SmartGroup = "movies" | "shows" | "episodes" | "songs" | "audiobooks";
export const SMART_SORTS = [
  "title",
  "titleDesc",
  "newest",
  "oldest",
  "added",
  "addedOldest",
  "rating",
  "ratingLowest",
  "longest",
  "shortest",
  "watchedRecently",
  "watchedLongAgo",
  "genre",
  "imdb",
  "rottenTomatoes",
  "average",
  "contentRating",
  "quality",
  "random",
] as const;

const halfStars = z.number().int().min(1).max(10);

/** Rules saved before libraries were chosen by name said what kind of thing they held (`media`); that is read as the equivalent. */
function fromLegacy(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  let rules = input as Record<string, unknown>;
  // Rules saved with one order (`sort`) read as a list of one.
  if ("sort" in rules) {
    const { sort, ...rest } = rules;
    rules = "sorts" in rest ? rest : { ...rest, sorts: [sort] };
  }
  if (!("media" in rules)) return rules;
  const { media, libraryId, ...rest } = rules;
  const kind = media === "movies" ? ["movies"] : media === "shows" || media === "episodes" ? ["shows"] : media === "songs" ? ["music", "audio"] : media === "audiobooks" ? ["audiobooks"] : ["?"];
  return { ...rest, kinds: kind, showsAs: media === "episodes" ? "episodes" : "shows", libraryIds: typeof libraryId === "string" ? [libraryId] : [] };
}

const smartRulesObject = z
  .object({
    /** The libraries to draw from; none means every library of the kinds below that the owner can see. */
    libraryIds: z.array(z.string().uuid()).max(30).default([]),
    /** With no libraries chosen, only these kinds of library (none means all kinds). Set by older rules; the form chooses libraries instead. */
    kinds: z.array(z.enum(SMART_LIBRARY_KINDS)).max(5).default([]),
    /** A TV library holds shows, or their episodes one by one. */
    showsAs: z.enum(["shows", "episodes"]).default("shows"),
    /** Any of these genres (a show's genres for its episodes). */
    genres: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    /** My own rating, in half stars: at least / at most, and whether it must have one. */
    minStars: halfStars.nullable().default(null),
    maxStars: halfStars.nullable().default(null),
    rated: z.enum(["any", "rated", "unrated"]).default("any"),
    watched: z.enum(["any", "unwatched", "inProgress", "watched"]).default("any"),
    yearFrom: z.number().int().min(1800).max(2200).nullable().default(null),
    yearTo: z.number().int().min(1800).max(2200).nullable().default(null),
    addedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** How long it runs, in minutes (not for shows, which have no one length). */
    minMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
    maxMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
    /** Part of the name (or, for an episode, of its show's or its own). */
    titleContains: z.string().trim().max(80).nullable().default(null).transform((v) => (v ? v : null)),
    /** The most a content rating may ask of the viewer, as an age (0 is for everyone); titles with no rating are left out. */
    maxAge: z.number().int().min(0).max(21).nullable().default(null),
    /** IMDb score (1 to 10) and Rotten Tomatoes score (1 to 100) at least. */
    minImdb: z.number().min(1).max(10).nullable().default(null),
    minRottenTomatoes: z.number().int().min(1).max(100).nullable().default(null),
    /** What everyone on the server who rated it gave it, on average, in half stars: at least. */
    minAverage: halfStars.nullable().default(null),
    /** A name among its cast and crew (movies, shows), its artist (songs) or its authors and narrators (audiobooks). */
    person: z.string().trim().max(80).nullable().default(null).transform((v) => (v ? v : null)),
    /** The picture is at least this tall, in pixels (720, 1080, 2160...). */
    minHeight: z.number().int().min(240).max(4320).nullable().default(null),
    /** This profile watched it in the last N days / has not in the last N days (never watched counts as not). */
    watchedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
    notWatchedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** The order, most important first: the next one only breaks ties in the one before. A random order ends the list. */
    sorts: z.array(z.enum(SMART_SORTS)).min(1).max(SMART_MAX_SORTS).default(["title"]).transform((list) => [...new Set(list)]),
    limit: z.number().int().min(1).max(SMART_MAX_LIMIT).default(50),
  })
  .strict();
export const smartRulesSchema = z.preprocess(fromLegacy, smartRulesObject);
export type SmartRules = z.infer<typeof smartRulesObject>;

/** A random order is kept as it is until asked to reshuffle; the rest are brought up to date this often. */
export const SMART_STALE_MS = 10 * 60 * 1000;

export type SmartTarget = { titleId: string } | { episodeId: string };

const key = (t: SmartTarget) => ("titleId" in t ? `t:${t.titleId}` : `e:${t.episodeId}`);

/** The conditions about the profile's own rating, on `ownerKind`/`idColumn`. */
function ratingConditions(rules: SmartRules, viewerId: string, kind: "title" | "episode", idColumn: SQL): { mine: SQL; conditions: SQL[] } {
  const mine = sql`(SELECT r.half_stars FROM ratings r WHERE r.viewer_id = ${viewerId} AND r.owner_kind = ${kind} AND r.owner_id = ${idColumn})`;
  const conditions: SQL[] = [];
  if (rules.rated === "rated" || rules.minStars !== null || rules.maxStars !== null) conditions.push(sql`${mine} IS NOT NULL`);
  if (rules.rated === "unrated") conditions.push(sql`${mine} IS NULL`);
  if (rules.minStars !== null) conditions.push(sql`${mine} >= ${rules.minStars}`);
  if (rules.maxStars !== null) conditions.push(sql`${mine} <= ${rules.maxStars}`);
  return { mine, conditions };
}

/** The condition on watching, for something that has a place of its own (a movie, a song, a book, an episode). */
function simpleWatched(rules: SmartRules, viewerId: string, kind: "title" | "episode", idColumn: SQL): SQL | null {
  const state = (extra: SQL) => sql`EXISTS (SELECT 1 FROM watch_state w WHERE w.viewer_id = ${viewerId} AND w.owner_kind = ${kind} AND w.owner_id = ${idColumn} AND ${extra})`;
  if (rules.watched === "watched") return state(sql`w.finished`);
  if (rules.watched === "inProgress") return state(sql`NOT w.finished AND w.position_seconds > 0`);
  if (rules.watched === "unwatched") return sql`NOT ${state(sql`(w.finished OR w.position_seconds > 0)`)}`;
  return null;
}

/** A show: watched when every playable episode is finished, in progress when some are finished or begun but not all, unwatched when none. */
function showWatched(rules: SmartRules, viewerId: string, showId: SQL): SQL | null {
  if (rules.watched === "any") return null;
  const playable = sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'episode' AND m.owner_id = e.id)`;
  const total = sql`(SELECT count(*) FROM episodes e JOIN seasons sn ON sn.id = e.season_id WHERE sn.title_id = ${showId} AND ${playable})`;
  const done = sql`(SELECT count(*) FROM episodes e JOIN seasons sn ON sn.id = e.season_id JOIN watch_state w ON w.owner_kind = 'episode' AND w.owner_id = e.id AND w.viewer_id = ${viewerId} AND w.finished WHERE sn.title_id = ${showId} AND ${playable})`;
  const begun = sql`(SELECT count(*) FROM episodes e JOIN seasons sn ON sn.id = e.season_id JOIN watch_state w ON w.owner_kind = 'episode' AND w.owner_id = e.id AND w.viewer_id = ${viewerId} AND (w.finished OR w.position_seconds > 0) WHERE sn.title_id = ${showId} AND ${playable})`;
  if (rules.watched === "watched") return sql`(${total} > 0 AND ${done} = ${total})`;
  if (rules.watched === "unwatched") return sql`${begun} = 0`;
  return sql`(${begun} > 0 AND ${done} < ${total})`;
}

function genreCondition(genres: string[], column: SQL): SQL | null {
  if (genres.length === 0) return null;
  return sql`(${sql.join(genres.map((g) => sql`${column} @> ${JSON.stringify([g])}::jsonb`), sql` OR `)})`;
}

/** How long something runs, in seconds: its stated runtime, else what its files add up to (a copy saved in several resolutions counts once). */
export const runtimeOf = (kind: "title" | "episode", runtime: SQL, id: SQL) =>
  sql`COALESCE(${runtime}, (SELECT sum(m.duration_seconds)::float / greatest(1, count(DISTINCT coalesce(m.version_label, ''))) FROM media_files m WHERE m.owner_kind = ${kind} AND m.owner_id = ${id}))`;

function durationConditions(rules: SmartRules, runtime: SQL): SQL[] {
  const out: SQL[] = [];
  if (rules.minMinutes !== null) out.push(sql`${runtime} >= ${rules.minMinutes * 60}`);
  if (rules.maxMinutes !== null) out.push(sql`${runtime} <= ${rules.maxMinutes * 60}`);
  return out;
}

const FILE_OF_TITLE = (id: SQL) => sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${id})`;
const PLAYABLE_SHOW = (id: SQL) => sql`EXISTS (SELECT 1 FROM seasons sn JOIN episodes e ON e.season_id = sn.id JOIN media_files m ON m.owner_kind = 'episode' AND m.owner_id = e.id WHERE sn.title_id = ${id})`;

/** The conditions and sort values that read the same for a title and for an episode (through its show). */
export interface Subject {
  /** The kind and id the profile's ratings and the files hang from. */
  kind: "title" | "episode";
  id: SQL;
  /** The title whose cast, crew, name, genres, scores and content rating count (an episode's show). */
  titleId: SQL;
  name: SQL;
  /** A second name to search (an episode's own). */
  otherName?: SQL;
  ratingAges: SQL;
  imdb: SQL;
  rottenTomatoes: SQL;
  watchedAt: SQL;
  /** True for a show, whose files are those of its episodes. */
  isShow?: boolean;
  /** Songs and books also name their people on the title itself. */
  titleIsMusic?: boolean;
}

const effectiveAge = (ratingAges: SQL, country: string) => sql`COALESCE((${ratingAges}->>${country})::int, (${ratingAges}->>'US')::int, (${ratingAges}->>'ANY')::int)`;

export const heightOf = (t: Subject) =>
  t.isShow
    ? sql`(SELECT max(m.height) FROM media_files m JOIN episodes e ON m.owner_kind = 'episode' AND m.owner_id = e.id JOIN seasons sn ON sn.id = e.season_id WHERE sn.title_id = ${t.id})`
    : sql`(SELECT max(m.height) FROM media_files m WHERE m.owner_kind = ${t.kind} AND m.owner_id = ${t.id})`;

export const averageOfSubject = (t: Subject) => sql`(SELECT avg(r.half_stars)::float FROM ratings r WHERE r.owner_kind = ${t.kind} AND r.owner_id = ${t.id})`;

/** The conditions that are about the thing itself rather than the profile's history. */
function subjectConditions(rules: SmartRules, t: Subject, viewer: AccessProfile, since: { watched: Date | null; notWatched: Date | null }): SQL[] {
  const out: SQL[] = [];
  if (rules.titleContains) {
    const q = rules.titleContains.toLowerCase();
    out.push(t.otherName ? sql`(strpos(lower(${t.name}), ${q}) > 0 OR strpos(lower(${t.otherName}), ${q}) > 0)` : sql`strpos(lower(${t.name}), ${q}) > 0`);
  }
  if (rules.maxAge !== null) out.push(sql`${effectiveAge(t.ratingAges, countryFromLocale(viewer.locale))} <= ${rules.maxAge}`);
  if (rules.minImdb !== null) out.push(sql`${t.imdb} >= ${rules.minImdb}`);
  if (rules.minRottenTomatoes !== null) out.push(sql`${t.rottenTomatoes} >= ${rules.minRottenTomatoes}`);
  if (rules.minAverage !== null) out.push(sql`${averageOfSubject(t)} >= ${rules.minAverage}`);
  if (rules.minHeight !== null) out.push(sql`${heightOf(t)} >= ${rules.minHeight}`);
  if (rules.person) {
    const q = rules.person.toLowerCase();
    out.push(
      sql`(EXISTS (SELECT 1 FROM title_cast c WHERE c.title_id = ${t.titleId} AND strpos(lower(c.name), ${q}) > 0)
        OR EXISTS (SELECT 1 FROM title_crew c WHERE c.title_id = ${t.titleId} AND strpos(lower(c.name), ${q}) > 0)
        OR EXISTS (SELECT 1 FROM titles pt JOIN music_albums al ON al.id = pt.album_id JOIN music_artists ar ON ar.id = al.artist_id WHERE pt.id = ${t.titleId} AND strpos(lower(ar.name), ${q}) > 0)
        OR EXISTS (SELECT 1 FROM titles pt WHERE pt.id = ${t.titleId} AND (strpos(lower(coalesce(pt.authors::text, '')), ${q}) > 0 OR strpos(lower(coalesce(pt.narrators::text, '')), ${q}) > 0)))`
    );
  }
  if (since.watched) out.push(sql`${t.watchedAt} >= ${since.watched.toISOString()}::timestamptz`);
  if (since.notWatched) out.push(sql`(${t.watchedAt} IS NULL OR ${t.watchedAt} < ${since.notWatched.toISOString()}::timestamptz)`);
  return out;
}

interface Entry {
  target: SmartTarget;
  name: string;
  year: number | null;
  added: Date;
  mine: number | null;
  /** How long it runs, in seconds (shows have none). */
  runtime: number | null;
  /** When this profile last watched any of it. */
  watchedAt: Date | null;
  /** Its first genre, A to Z. */
  genre: string | null;
  imdb: number | null;
  rottenTomatoes: number | null;
  /** What everyone on the server gave it, on average, in half stars. */
  average: number | null;
  /** The age its content rating asks of the viewer. */
  age: number | null;
  /** The height of its picture, in pixels. */
  quality: number | null;
}

/** The values a group's query can order by. */
interface SortKeys {
  name: SQL;
  year: SQL;
  added: SQL;
  mine: SQL;
  runtime: SQL;
  watchedAt: SQL;
  genre: SQL;
  imdb: SQL;
  rottenTomatoes: SQL;
  average: SQL;
  age: SQL;
  quality: SQL;
  /** What breaks a tie, in order (a show's episodes keep their order). */
  tie: SQL[];
}

/** What one sort orders by (what is missing is always last). */
function primaryOrdering(sort: SmartRules["sorts"][number], k: SortKeys): SQL {
  switch (sort) {
    case "random":
      return sql`random()`;
    case "titleDesc":
      return sql`${k.name} DESC`;
    case "newest":
      return sql`${k.year} DESC NULLS LAST`;
    case "oldest":
      return sql`${k.year} ASC NULLS LAST`;
    case "added":
      return sql`${k.added} DESC`;
    case "addedOldest":
      return sql`${k.added} ASC`;
    case "rating":
      return sql`${k.mine} DESC NULLS LAST`;
    case "ratingLowest":
      return sql`${k.mine} ASC NULLS LAST`;
    case "longest":
      return sql`${k.runtime} DESC NULLS LAST`;
    case "shortest":
      return sql`${k.runtime} ASC NULLS LAST`;
    case "watchedRecently":
      return sql`${k.watchedAt} DESC NULLS LAST`;
    case "watchedLongAgo":
      return sql`${k.watchedAt} ASC NULLS LAST`;
    case "genre":
      return sql`${k.genre} ASC NULLS LAST`;
    case "imdb":
      return sql`${k.imdb} DESC NULLS LAST`;
    case "rottenTomatoes":
      return sql`${k.rottenTomatoes} DESC NULLS LAST`;
    case "average":
      return sql`${k.average} DESC NULLS LAST`;
    case "contentRating":
      return sql`${k.age} ASC NULLS LAST`;
    case "quality":
      return sql`${k.quality} DESC NULLS LAST`;
    default:
      return k.name;
  }
}

/** The ORDER BY for the orders chosen, most important first, ending by name (and a show's episodes in their order). A random order ends the list. */
function orderingFor(sorts: SmartRules["sorts"], k: SortKeys): SQL[] {
  const out: SQL[] = [];
  for (const sort of sorts) {
    out.push(primaryOrdering(sort, k));
    if (sort === "random") return out;
  }
  return [...out, k.name, ...k.tie];
}

/** Which kinds of thing the rules hold, from the libraries they name (or the kinds, or everything). */
export async function groupsOf(ex: Executor, rules: SmartRules, actor: LibraryActor): Promise<SmartGroup[]> {
  let kinds: readonly LibraryKind[] = rules.kinds.length ? rules.kinds : SMART_LIBRARY_KINDS;
  if (rules.libraryIds.length) {
    const rows = await ex.select({ kind: libraries.kind }).from(libraries).where(and(inArray(libraries.id, rules.libraryIds), libraryVisible(ex, actor)));
    kinds = rows.map((r) => r.kind);
  }
  const groups = new Set<SmartGroup>();
  for (const k of kinds) {
    if (k === "movies") groups.add("movies");
    else if (k === "shows") groups.add(rules.showsAs);
    else if (k === "audiobooks") groups.add("audiobooks");
    else if ((SONG_LIBRARY_KINDS as readonly string[]).includes(k)) groups.add("songs");
  }
  return [...groups];
}

/** Puts entries from the different kinds of thing in the order asked for (each kind was already cut to the limit in that order). */
function arrange(entries: Entry[], sorts: SmartRules["sorts"]): Entry[] {
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  /** Compares two values that may be missing; missing is always last, whichever way the rest goes. */
  const by = <T>(x: T | null, y: T | null, cmp: (p: T, q: T) => number): number => (x === null || y === null ? (x === y ? 0 : x === null ? 1 : -1) : cmp(x, y));
  const num = (p: number, q: number) => p - q;
  const time = (p: Date, q: Date) => p.getTime() - q.getTime();
  const compare = (sort: SmartRules["sorts"][number], a: Entry, b: Entry): number => {
    switch (sort) {
      case "titleDesc":
        return byName(b, a);
      case "newest":
        return by(a.year, b.year, (p, q) => q - p);
      case "oldest":
        return by(a.year, b.year, num);
      case "added":
        return time(b.added, a.added);
      case "addedOldest":
        return time(a.added, b.added);
      case "rating":
        return by(a.mine, b.mine, (p, q) => q - p);
      case "ratingLowest":
        return by(a.mine, b.mine, num);
      case "longest":
        return by(a.runtime, b.runtime, (p, q) => q - p);
      case "shortest":
        return by(a.runtime, b.runtime, num);
      case "watchedRecently":
        return by(a.watchedAt, b.watchedAt, (p, q) => time(q, p));
      case "watchedLongAgo":
        return by(a.watchedAt, b.watchedAt, time);
      case "genre":
        return by(a.genre, b.genre, (p, q) => p.localeCompare(q));
      case "imdb":
        return by(a.imdb, b.imdb, (p, q) => q - p);
      case "rottenTomatoes":
        return by(a.rottenTomatoes, b.rottenTomatoes, (p, q) => q - p);
      case "average":
        return by(a.average, b.average, (p, q) => q - p);
      case "contentRating":
        return by(a.age, b.age, num);
      case "quality":
        return by(a.quality, b.quality, (p, q) => q - p);
      default:
        return byName(a, b);
    }
  };
  // A random order ends the list: whatever the orders before it leave tied is put in a random order, and nothing after it could matter.
  const random = sorts.includes("random");
  const chosen = random ? sorts.slice(0, sorts.indexOf("random")) : sorts;
  const luck = new Map(entries.map((e) => [e, Math.random()]));
  return [...entries].sort((a, b) => {
    for (const sort of chosen) {
      const r = compare(sort, a, b);
      if (r !== 0) return r;
    }
    return random ? (luck.get(a) ?? 0) - (luck.get(b) ?? 0) : byName(a, b);
  });
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const pad = (n: number) => String(n).padStart(5, "0");

async function episodesEntries(ex: Executor, rules: SmartRules, a: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; since: Date | null; sinceWatch: { watched: Date | null; notWatched: Date | null } }): Promise<Entry[]> {
  const id = sql`${episodes.id}`;
  const { mine, conditions } = ratingConditions(rules, a.viewerId, "episode", id);
  const watched = simpleWatched(rules, a.viewerId, "episode", id);
  const runtime = runtimeOf("episode", sql`${episodes.runtimeSeconds}`, id);
  const watchedAt = sql`(SELECT max(w.updated_at) FROM watch_state w WHERE w.viewer_id = ${a.viewerId} AND w.owner_kind = 'episode' AND w.owner_id = ${id})`;
  const genre = sql`(SELECT min(g.value) FROM jsonb_array_elements_text(${titles.genres}) AS g(value))`;
  const subject: Subject = { kind: "episode", id, titleId: sql`${titles.id}`, name: sql`${titles.name}`, otherName: sql`coalesce(${episodes.name}, '')`, ratingAges: sql`${titles.ratingAges}`, imdb: sql`${titles.imdbRating}`, rottenTomatoes: sql`${titles.rottenTomatoesScore}`, watchedAt };
  const rows = await ex
    .select({ id: episodes.id, show: titles.name, year: titles.year, added: titles.addedAt, season: seasons.number, number: episodes.number, mine: sql<number | null>`${mine}`, runtime: sql<number | null>`${runtime}`, watchedAt: sql<Date | null>`${watchedAt}`, genre: sql<string | null>`${genre}`, imdb: sql<number | null>`${subject.imdb}`, rottenTomatoes: sql<number | null>`${subject.rottenTomatoes}`, average: sql<number | null>`${averageOfSubject(subject)}`, age: sql<number | null>`${effectiveAge(subject.ratingAges, countryFromLocale(a.viewer.locale))}`, quality: sql<number | null>`${heightOf(subject)}` })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .innerJoin(titles, eq(titles.id, seasons.titleId))
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        eq(titles.kind, "show"),
        libraryVisible(ex, a.actor),
        contentFilter(a.viewer, titles.ratingAges),
        sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'episode' AND m.owner_id = ${episodes.id})`,
        rules.libraryIds.length ? inArray(titles.libraryId, rules.libraryIds) : undefined,
        genreCondition(rules.genres, sql`${titles.genres}`) ?? undefined,
        rules.yearFrom !== null ? sql`${titles.year} >= ${rules.yearFrom}` : undefined,
        rules.yearTo !== null ? sql`${titles.year} <= ${rules.yearTo}` : undefined,
        a.since ? sql`${titles.addedAt} >= ${a.since.toISOString()}::timestamptz` : undefined,
        watched ?? undefined,
        ...durationConditions(rules, runtime),
        ...subjectConditions(rules, subject, a.viewer, a.sinceWatch),
        ...conditions
      )
    )
    .orderBy(...orderingFor(rules.sorts, { name: sql`lower(${titles.name})`, year: sql`${titles.year}`, added: sql`${titles.addedAt}`, mine, runtime, watchedAt, genre, imdb: subject.imdb, rottenTomatoes: subject.rottenTomatoes, average: averageOfSubject(subject), age: effectiveAge(subject.ratingAges, countryFromLocale(a.viewer.locale)), quality: heightOf(subject), tie: [sql`${seasons.number}`, sql`${episodes.number}`] }))
    .limit(rules.limit);
  return rows.map((r) => ({ target: { episodeId: r.id }, name: `${r.show} S${pad(r.season)}E${pad(r.number)}`, year: r.year, added: r.added, mine: r.mine ?? null, runtime: r.runtime === null ? null : Number(r.runtime), watchedAt: r.watchedAt ? new Date(r.watchedAt) : null, genre: r.genre ?? null, imdb: num(r.imdb), rottenTomatoes: num(r.rottenTomatoes), average: num(r.average), age: num(r.age), quality: num(r.quality) }));
}

async function titleEntries(ex: Executor, rules: SmartRules, group: "movies" | "shows" | "songs" | "audiobooks", a: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; since: Date | null; sinceWatch: { watched: Date | null; notWatched: Date | null } }): Promise<Entry[]> {
  const id = sql`${titles.id}`;
  const { mine, conditions } = ratingConditions(rules, a.viewerId, "title", id);
  const watched = group === "shows" ? showWatched(rules, a.viewerId, id) : simpleWatched(rules, a.viewerId, "title", id);
  // A show has no length of its own; the last time it was watched is the last time any of its episodes was.
  const runtime = group === "shows" ? sql`NULL::float` : runtimeOf("title", sql`${titles.runtimeSeconds}`, id);
  const watchedAt =
    group === "shows"
      ? sql`(SELECT max(w.updated_at) FROM watch_state w JOIN episodes e ON e.id = w.owner_id JOIN seasons sn ON sn.id = e.season_id WHERE w.viewer_id = ${a.viewerId} AND w.owner_kind = 'episode' AND sn.title_id = ${id})`
      : sql`(SELECT max(w.updated_at) FROM watch_state w WHERE w.viewer_id = ${a.viewerId} AND w.owner_kind = 'title' AND w.owner_id = ${id})`;
  const genre = sql`(SELECT min(g.value) FROM jsonb_array_elements_text(${titles.genres}) AS g(value))`;
  const subject: Subject = { kind: "title", id, titleId: id, name: sql`${titles.name}`, ratingAges: sql`${titles.ratingAges}`, imdb: sql`${titles.imdbRating}`, rottenTomatoes: sql`${titles.rottenTomatoesScore}`, watchedAt, isShow: group === "shows" };
  const kindCondition =
    group === "movies"
      ? and(eq(titles.kind, "movie"), FILE_OF_TITLE(id))
      : group === "shows"
        ? and(eq(titles.kind, "show"), PLAYABLE_SHOW(id))
        : and(eq(titles.kind, "audiobook"), group === "songs" ? inArray(libraries.kind, [...SONG_LIBRARY_KINDS]) : eq(libraries.kind, "audiobooks"), FILE_OF_TITLE(id));
  const rows = await ex
    .select({ id: titles.id, name: titles.name, year: titles.year, added: titles.addedAt, mine: sql<number | null>`${mine}`, runtime: sql<number | null>`${runtime}`, watchedAt: sql<Date | null>`${watchedAt}`, genre: sql<string | null>`${genre}`, imdb: sql<number | null>`${subject.imdb}`, rottenTomatoes: sql<number | null>`${subject.rottenTomatoes}`, average: sql<number | null>`${averageOfSubject(subject)}`, age: sql<number | null>`${effectiveAge(subject.ratingAges, countryFromLocale(a.viewer.locale))}`, quality: sql<number | null>`${heightOf(subject)}` })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        kindCondition,
        libraryVisible(ex, a.actor),
        contentFilter(a.viewer, titles.ratingAges),
        hasPlayableFile(titles.id, titles.kind),
        rules.libraryIds.length ? inArray(titles.libraryId, rules.libraryIds) : undefined,
        genreCondition(rules.genres, sql`${titles.genres}`) ?? undefined,
        rules.yearFrom !== null ? sql`${titles.year} >= ${rules.yearFrom}` : undefined,
        rules.yearTo !== null ? sql`${titles.year} <= ${rules.yearTo}` : undefined,
        a.since ? sql`${titles.addedAt} >= ${a.since.toISOString()}::timestamptz` : undefined,
        watched ?? undefined,
        ...(group === "shows" ? [] : durationConditions(rules, runtime)),
        ...subjectConditions(rules, subject, a.viewer, a.sinceWatch),
        ...conditions
      )
    )
    .orderBy(...orderingFor(rules.sorts, { name: sql`lower(${titles.name})`, year: sql`${titles.year}`, added: sql`${titles.addedAt}`, mine, runtime, watchedAt, genre, imdb: subject.imdb, rottenTomatoes: subject.rottenTomatoes, average: averageOfSubject(subject), age: effectiveAge(subject.ratingAges, countryFromLocale(a.viewer.locale)), quality: heightOf(subject), tie: [] }))
    .limit(rules.limit);
  return rows.map((r) => ({ target: { titleId: r.id }, name: r.name, year: r.year, added: r.added, mine: r.mine ?? null, runtime: r.runtime === null ? null : Number(r.runtime), watchedAt: r.watchedAt ? new Date(r.watchedAt) : null, genre: r.genre ?? null, imdb: num(r.imdb), rottenTomatoes: num(r.rottenTomatoes), average: num(r.average), age: num(r.age), quality: num(r.quality) }));
}

/** What the rules select for this profile, in order. */
export async function evaluateRules(ex: Executor, args: { rules: SmartRules; actor: LibraryActor; viewer: AccessProfile; viewerId: string; now?: Date }): Promise<SmartTarget[]> {
  const { rules, actor, viewer, viewerId } = args;
  const since = rules.addedWithinDays ? new Date((args.now ?? new Date()).getTime() - rules.addedWithinDays * 86_400_000) : null;
  const now = args.now ?? new Date();
  const days = (n: number | null) => (n ? new Date(now.getTime() - n * 86_400_000) : null);
  const a = { actor, viewer, viewerId, since, sinceWatch: { watched: days(rules.watchedWithinDays), notWatched: days(rules.notWatchedWithinDays) } };
  const entries: Entry[] = [];
  for (const group of await groupsOf(ex, rules, actor)) entries.push(...(group === "episodes" ? await episodesEntries(ex, rules, a) : await titleEntries(ex, rules, group, a)));
  return arrange(entries, rules.sorts).slice(0, rules.limit).map((e) => e.target);
}

/**
 * Makes a smart playlist's items what its rules select now, keeping the rows (and so their ids and any queue pointing at them) of items that
 * stay, and moving them to their new places. Returns how many items it holds. Does nothing for an ordinary playlist.
 */
export async function refreshSmartPlaylist(ex: Executor, playlistId: string, opts: { force?: boolean; now?: Date } = {}): Promise<number | null> {
  const now = opts.now ?? new Date();
  return ex.transaction(async (tx) => {
    const [pl] = await tx.select().from(playlists).where(eq(playlists.id, playlistId)).for("update");
    if (!pl?.smartRules) return null;
    const parsed = smartRulesSchema.safeParse(pl.smartRules);
    if (!parsed.success || !pl.ownerViewerId) return null; // no owner left to evaluate for: it stays as it was
    const rules = parsed.data;
    const fresh = pl.smartRefreshedAt && now.getTime() - pl.smartRefreshedAt.getTime() < (rules.sorts.includes("random") ? Infinity : SMART_STALE_MS);
    if (fresh && !opts.force) return null;

    const [owner] = await tx.select().from(viewers).where(eq(viewers.id, pl.ownerViewerId));
    if (!owner) return null;
    const [membership] = await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, pl.serverId), eq(serverMembers.profileId, owner.accountId)));
    if (!membership) return null;
    const actor: LibraryActor = { serverId: pl.serverId, accountId: owner.accountId, isAdmin: membership.role === "admin" };
    const access: AccessProfile = { locale: owner.locale, maxAge: owner.maxAge, allowUnrated: owner.allowUnrated };
    const wanted = await evaluateRules(tx as unknown as Executor, { rules, actor, viewer: access, viewerId: owner.id, now });

    const have = await tx.select({ id: playlistItems.id, titleId: playlistItems.titleId, episodeId: playlistItems.episodeId, position: playlistItems.position }).from(playlistItems).where(eq(playlistItems.playlistId, playlistId));
    const haveByKey = new Map(have.map((r) => [r.titleId ? `t:${r.titleId}` : `e:${r.episodeId}`, r]));
    const wantedKeys = new Set(wanted.map(key));
    const gone = have.filter((r) => !wantedKeys.has(r.titleId ? `t:${r.titleId}` : `e:${r.episodeId}`)).map((r) => r.id);
    if (gone.length) await tx.delete(playlistItems).where(inArray(playlistItems.id, gone));
    for (const [i, target] of wanted.entries()) {
      const position = (i + 1) * POSITION_GAP;
      const existing = haveByKey.get(key(target));
      if (existing) {
        if (Number(existing.position) !== position) await tx.update(playlistItems).set({ position }).where(eq(playlistItems.id, existing.id));
      } else {
        await tx.insert(playlistItems).values({ playlistId, ...target, position, addedByViewerId: owner.id });
      }
    }
    await tx.update(playlists).set({ smartRefreshedAt: now }).where(eq(playlists.id, playlistId));
    return wanted.length;
  });
}

/** Brings any smart playlists among these up to date if they have gone stale (cheap when none are smart). */
export async function refreshSmartIfStale(ex: Executor, playlistIds: string[], now: Date = new Date()): Promise<void> {
  if (playlistIds.length === 0) return;
  const smart = await ex.select({ id: playlists.id }).from(playlists).where(and(inArray(playlists.id, playlistIds), isNotNull(playlists.smartRules)));
  for (const p of smart) await refreshSmartPlaylist(ex, p.id, { now });
}
