/**
 * "More like this" and "Recommended for you", from what the library itself knows about each film and show (genres, cast, directors and
 * creators, year) and what this profile has rated or watched. Nothing leaves the server and nothing is shared between profiles. Only what the
 * profile may see (library sharing, age limit) and can play is ever offered.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, libraries, ratings, seasons, titleCast, titleCrew, titles, watchState } from "@/lib/db/schema";
import { contentFilter, type AccessProfile } from "@/lib/content/access";
import { libraryVisible, type LibraryActor } from "@/lib/content/library-access";
import { fit, MIN_SIMILARITY, ratingWeight, similarity, type Features, type Taste } from "@/lib/recommend/score";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface Rec {
  id: string;
  kind: "movie" | "show";
  name: string;
  year: number | null;
  posterUrl: string | null;
}

export interface Recommendations {
  forYou: (Rec & { because: { id: string; name: string } | null })[];
  /** Rows of "because you liked X". */
  because: { title: { id: string; name: string }; items: Rec[] }[];
}

interface Candidate extends Rec {
  imdbRating: number | null;
}

const MAX_CANDIDATES = 4000;
/** The least a recommendation must fit (a title only liked by finishing it counts for little, but still counts). */
const MIN_FIT = 0.3;
const TOP_CAST = 8;
const MAKER_JOBS = ["Director", "Creator"];

/** The movies and shows this profile can see and play, newest first (capped). */
async function candidates(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile }): Promise<Candidate[]> {
  const rows = await ex
    .select({ id: titles.id, kind: titles.kind, name: titles.name, year: titles.year, posterUrl: titles.posterUrl, imdbRating: titles.imdbRating })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(
      and(
        inArray(titles.kind, ["movie", "show"]),
        libraryVisible(ex, args.actor),
        contentFilter(args.viewer, titles.ratingAges),
        sql`(CASE WHEN ${titles.kind} = 'movie'
              THEN EXISTS (SELECT 1 FROM media_files m WHERE m.owner_kind = 'title' AND m.owner_id = ${titles.id})
              ELSE EXISTS (SELECT 1 FROM seasons sn JOIN episodes e ON e.season_id = sn.id JOIN media_files m ON m.owner_kind = 'episode' AND m.owner_id = e.id WHERE sn.title_id = ${titles.id}) END)`
      )
    )
    .orderBy(desc(titles.addedAt))
    .limit(MAX_CANDIDATES);
  return rows.map((r) => ({ id: r.id, kind: r.kind as "movie" | "show", name: r.name, year: r.year, posterUrl: r.posterUrl, imdbRating: r.imdbRating }));
}

/** Genres, top cast, and directors or creators, for the given titles. */
async function featuresOf(ex: Db, rows: { id: string; year: number | null; genres?: string[] | null }[]): Promise<Map<string, Features>> {
  const ids = rows.map((r) => r.id);
  const out = new Map<string, { genres: Set<string>; cast: Set<number>; makers: Set<number>; year: number | null }>();
  if (ids.length === 0) return new Map();
  const genreRows = await ex.select({ id: titles.id, genres: titles.genres }).from(titles).where(inArray(titles.id, ids));
  const yearOf = new Map(rows.map((r) => [r.id, r.year]));
  for (const g of genreRows) out.set(g.id, { genres: new Set(g.genres ?? []), cast: new Set(), makers: new Set(), year: yearOf.get(g.id) ?? null });
  const cast = await ex.select({ id: titleCast.titleId, person: titleCast.personId }).from(titleCast).where(and(inArray(titleCast.titleId, ids), sql`${titleCast.position} < ${TOP_CAST}`));
  for (const c of cast) out.get(c.id)?.cast.add(c.person);
  const makers = await ex.select({ id: titleCrew.titleId, person: titleCrew.personId }).from(titleCrew).where(and(inArray(titleCrew.titleId, ids), inArray(titleCrew.job, MAKER_JOBS)));
  for (const m of makers) out.get(m.id)?.makers.add(m.person);
  return out;
}

const asRec = (c: Candidate): Rec => ({ id: c.id, kind: c.kind, name: c.name, year: c.year, posterUrl: c.posterUrl });

/** The titles most like the given one (not itself, nor anything in `exclude`), best first. */
export async function similarTitles(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; titleId: string; limit?: number; exclude?: string[] }): Promise<Rec[]> {
  const pool = await candidates(ex, args);
  const [self] = await ex.select({ id: titles.id, year: titles.year }).from(titles).innerJoin(libraries, eq(libraries.id, titles.libraryId)).where(and(eq(titles.id, args.titleId), libraryVisible(ex, args.actor), contentFilter(args.viewer, titles.ratingAges))).limit(1);
  if (!self) return [];
  const skip = new Set([args.titleId, ...(args.exclude ?? [])]);
  const others = pool.filter((c) => !skip.has(c.id));
  const feats = await featuresOf(ex, [self, ...others]);
  const mine = feats.get(self.id);
  if (!mine) return [];
  const sameKind = (await ex.select({ kind: titles.kind }).from(titles).where(eq(titles.id, self.id)).limit(1))[0]?.kind;
  return others
    .filter((c) => c.kind === sameKind)
    .map((c) => ({ c, s: similarity(mine, feats.get(c.id) as Features) }))
    .filter((x) => x.s >= MIN_SIMILARITY)
    .sort((a, b) => b.s - a.s || (b.c.imdbRating ?? 0) - (a.c.imdbRating ?? 0) || a.c.name.localeCompare(b.c.name))
    .slice(0, args.limit ?? 12)
    .map((x) => asRec(x.c));
}

/**
 * What this profile has liked: titles it rated well (more weight for more stars), rated badly (negative), or finished without rating (a little),
 * as taste to match candidates against.
 */
async function tasteOf(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string }): Promise<{ taste: Taste[]; seen: Set<string>; recent: string[] }> {
  const rated = await ex.select({ id: ratings.ownerId, half: ratings.halfStars, at: ratings.updatedAt }).from(ratings).where(and(eq(ratings.viewerId, args.viewerId), eq(ratings.ownerKind, "title")));
  const movieStates = await ex.select({ id: watchState.ownerId, finished: watchState.finished }).from(watchState).where(and(eq(watchState.viewerId, args.viewerId), eq(watchState.ownerKind, "title")));
  const showStates = await ex
    .select({ id: seasons.titleId, finished: sql<boolean>`bool_or(${watchState.finished})` })
    .from(watchState)
    .innerJoin(episodes, eq(episodes.id, watchState.ownerId))
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(and(eq(watchState.viewerId, args.viewerId), eq(watchState.ownerKind, "episode")))
    .groupBy(seasons.titleId);
  const ratingOf = new Map(rated.map((r) => [r.id, r.half]));
  const finished = new Set([...movieStates, ...showStates].filter((s) => s.finished).map((s) => s.id));
  const seen = new Set<string>([...rated.map((r) => r.id), ...movieStates.map((s) => s.id), ...showStates.map((s) => s.id)]);
  const ids = [...new Set([...ratingOf.keys(), ...finished])];
  if (ids.length === 0) return { taste: [], seen, recent: [] };
  const rows = await ex
    .select({ id: titles.id, name: titles.name, year: titles.year })
    .from(titles)
    .innerJoin(libraries, eq(libraries.id, titles.libraryId))
    .where(and(inArray(titles.id, ids), inArray(titles.kind, ["movie", "show"]), libraryVisible(ex, args.actor)));
  const feats = await featuresOf(ex, rows);
  const taste = rows
    .map((r) => ({ id: r.id, name: r.name, features: feats.get(r.id) as Features, weight: ratingWeight(ratingOf.get(r.id) ?? null, finished.has(r.id)) }))
    .filter((t) => t.weight !== 0 && t.features);
  const recent = rated.filter((r) => ratingWeight(r.half, false) > 0).sort((a, b) => b.at.getTime() - a.at.getTime()).map((r) => r.id);
  return { taste, seen, recent };
}

/**
 * Recommendations for a profile: titles it hasn't started or rated, ranked by how well they fit what it liked, plus a couple of "because you
 * liked X" rows for the titles it rated highest most recently. Empty until the profile has rated or finished something.
 */
export async function recommendations(ex: Db, args: { actor: LibraryActor; viewer: AccessProfile; viewerId: string; limit?: number }): Promise<Recommendations> {
  const limit = args.limit ?? 20;
  const { taste, seen, recent } = await tasteOf(ex, args);
  if (!taste.some((t) => t.weight > 0)) return { forYou: [], because: [] };
  const unseen = (await candidates(ex, args)).filter((c) => !seen.has(c.id));
  const feats = await featuresOf(ex, unseen);
  const scored = unseen
    .map((c) => ({ c, ...fit(feats.get(c.id) as Features, taste) }))
    .filter((x) => x.score >= MIN_FIT)
    .sort((a, b) => b.score - a.score || (b.c.imdbRating ?? 0) - (a.c.imdbRating ?? 0) || a.c.name.localeCompare(b.c.name));
  const forYou = scored.slice(0, limit).map((x) => ({ ...asRec(x.c), because: x.because ? { id: x.because.id, name: x.because.name } : null }));

  // "Because you liked X": the two most recently rated favourites, each with its closest unseen titles not already shown above.
  const shown = new Set(forYou.map((r) => r.id));
  const because: Recommendations["because"] = [];
  for (const id of recent) {
    if (because.length >= 2) break;
    const liked = taste.find((t) => t.id === id);
    if (!liked) continue;
    const items = unseen
      .filter((c) => !shown.has(c.id))
      .map((c) => ({ c, s: similarity(liked.features, feats.get(c.id) as Features) }))
      .filter((x) => x.s >= MIN_SIMILARITY)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => asRec(x.c));
    if (items.length < 3) continue;
    for (const i of items) shown.add(i.id);
    because.push({ title: { id: liked.id, name: liked.name }, items });
  }
  return { forYou, because };
}
