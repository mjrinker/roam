/**
 * Smart playlists: a playlist made by rules ("unwatched comedies from the 90s I rated 4 stars or more") that fills itself. The rules are
 * evaluated for the playlist's owner (their ratings, their watch history, what they may see) and the result is kept as the playlist's items
 * (so playing, queueing, sharing and the apps all work as for any playlist), brought up to date whenever the playlist is opened after a while.
 * Nobody edits the items of a smart playlist by hand; change the rules instead.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { episodes, libraries, playlistItems, playlists, seasons, serverMembers, titles, viewers } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { SONG_LIBRARY_KINDS } from "@/lib/libraries/profile";
import type { Executor } from "./executor";
import { SMART_MAX_LIMIT } from "./smart-words";
import { POSITION_GAP } from "./position";

export const SMART_MEDIA = ["movies", "shows", "episodes", "songs", "audiobooks"] as const;
export const SMART_SORTS = ["title", "newest", "oldest", "added", "rating", "random"] as const;

const halfStars = z.number().int().min(1).max(10);

export const smartRulesSchema = z
  .object({
    media: z.enum(SMART_MEDIA),
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
    libraryId: z.string().uuid().nullable().default(null),
    sort: z.enum(SMART_SORTS).default("title"),
    limit: z.number().int().min(1).max(SMART_MAX_LIMIT).default(50),
  })
  .strict();
export type SmartRules = z.infer<typeof smartRulesSchema>;

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
const runtimeOf = (kind: "title" | "episode", runtime: SQL, id: SQL) =>
  sql`COALESCE(${runtime}, (SELECT sum(m.duration_seconds)::float / greatest(1, count(DISTINCT coalesce(m.version_label, ''))) FROM media_files m WHERE m.owner_kind = ${kind} AND m.owner_id = ${id}))`;

function durationConditions(rules: SmartRules, runtime: SQL): SQL[] {
  const out: SQL[] = [];
  if (rules.minMinutes !== null) out.push(sql`${runtime} >= ${rules.minMinutes * 60}`);
  if (rules.maxMinutes !== null) out.push(sql`${runtime} <= ${rules.maxMinutes * 60}`);
  return out;
}

const FILE_OF_TITLE = (id: SQL) => sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${id})`;
const PLAYABLE_SHOW = (id: SQL) => sql`EXISTS (SELECT 1 FROM seasons sn JOIN episodes e ON e.season_id = sn.id JOIN media_files m ON m.owner_kind = 'episode' AND m.owner_id = e.id WHERE sn.title_id = ${id})`;

/** What the rules select for this profile, in order. */
export async function evaluateRules(ex: Executor, args: { rules: SmartRules; actor: LibraryActor; viewer: AccessProfile; viewerId: string; now?: Date }): Promise<SmartTarget[]> {
  const { rules, actor, viewer, viewerId } = args;
  const since = rules.addedWithinDays ? new Date((args.now ?? new Date()).getTime() - rules.addedWithinDays * 86_400_000) : null;

  if (rules.media === "episodes") {
    const id = sql`${episodes.id}`;
    const { mine, conditions } = ratingConditions(rules, viewerId, "episode", id);
    const watched = simpleWatched(rules, viewerId, "episode", id);
    const showTitles = titles;
    const rows = await ex
      .select({ id: episodes.id })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .innerJoin(showTitles, eq(showTitles.id, seasons.titleId))
      .innerJoin(libraries, eq(libraries.id, showTitles.libraryId))
      .where(
        and(
          eq(showTitles.kind, "show"),
          libraryVisible(ex, actor),
          contentFilter(viewer, showTitles.ratingAges),
          sql`EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'episode' AND m.owner_id = ${episodes.id})`,
          rules.libraryId ? eq(showTitles.libraryId, rules.libraryId) : undefined,
          genreCondition(rules.genres, sql`${showTitles.genres}`) ?? undefined,
          rules.yearFrom !== null ? sql`${showTitles.year} >= ${rules.yearFrom}` : undefined,
          rules.yearTo !== null ? sql`${showTitles.year} <= ${rules.yearTo}` : undefined,
          since ? sql`${showTitles.addedAt} >= ${since}` : undefined,
          watched ?? undefined,
          ...durationConditions(rules, runtimeOf("episode", sql`${episodes.runtimeSeconds}`, id)),
          ...conditions
        )
      )
      .orderBy(
        ...(rules.sort === "random"
          ? [sql`random()`]
          : rules.sort === "added"
            ? [desc(showTitles.addedAt), asc(showTitles.name), asc(seasons.number), asc(episodes.number)]
            : rules.sort === "rating"
              ? [sql`${mine} DESC NULLS LAST`, asc(showTitles.name), asc(seasons.number), asc(episodes.number)]
              : rules.sort === "newest"
                ? [sql`${showTitles.year} DESC NULLS LAST`, asc(showTitles.name), asc(seasons.number), asc(episodes.number)]
                : rules.sort === "oldest"
                  ? [sql`${showTitles.year} ASC NULLS LAST`, asc(showTitles.name), asc(seasons.number), asc(episodes.number)]
                  : [sql`lower(${showTitles.name})`, asc(seasons.number), asc(episodes.number)])
      )
      .limit(rules.limit);
    return rows.map((r) => ({ episodeId: r.id }));
  }

  const id = sql`${titles.id}`;
  const { mine, conditions } = ratingConditions(rules, viewerId, "title", id);
  const watched = rules.media === "shows" ? showWatched(rules, viewerId, id) : simpleWatched(rules, viewerId, "title", id);
  const kindCondition =
    rules.media === "movies"
      ? and(eq(titles.kind, "movie"), FILE_OF_TITLE(id))
      : rules.media === "shows"
        ? and(eq(titles.kind, "show"), PLAYABLE_SHOW(id))
        : and(eq(titles.kind, "audiobook"), rules.media === "songs" ? inArray(libraries.kind, [...SONG_LIBRARY_KINDS]) : eq(libraries.kind, "audiobooks"), FILE_OF_TITLE(id));
  const rows = await ex
    .select({ id: titles.id })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        kindCondition,
        libraryVisible(ex, actor),
        contentFilter(viewer, titles.ratingAges),
        rules.libraryId ? eq(titles.libraryId, rules.libraryId) : undefined,
        genreCondition(rules.genres, sql`${titles.genres}`) ?? undefined,
        rules.yearFrom !== null ? sql`${titles.year} >= ${rules.yearFrom}` : undefined,
        rules.yearTo !== null ? sql`${titles.year} <= ${rules.yearTo}` : undefined,
        since ? sql`${titles.addedAt} >= ${since}` : undefined,
        watched ?? undefined,
        ...(rules.media === "shows" ? [] : durationConditions(rules, runtimeOf("title", sql`${titles.runtimeSeconds}`, id))),
        ...conditions
      )
    )
    .orderBy(
      ...(rules.sort === "random"
        ? [sql`random()`]
        : rules.sort === "added"
          ? [desc(titles.addedAt), asc(titles.name)]
          : rules.sort === "rating"
            ? [sql`${mine} DESC NULLS LAST`, sql`lower(${titles.name})`]
            : rules.sort === "newest"
              ? [sql`${titles.year} DESC NULLS LAST`, sql`lower(${titles.name})`]
              : rules.sort === "oldest"
                ? [sql`${titles.year} ASC NULLS LAST`, sql`lower(${titles.name})`]
                : [sql`lower(${titles.name})`])
    )
    .limit(rules.limit);
  return rows.map((r) => ({ titleId: r.id }));
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
    const fresh = pl.smartRefreshedAt && now.getTime() - pl.smartRefreshedAt.getTime() < (rules.sort === "random" ? Infinity : SMART_STALE_MS);
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
