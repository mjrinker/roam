/** The cast and key crew of a TMDB movie or show, as rows shared by every server (tmdb_cast, tmdb_crew). */
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { CREW_LIMIT_DEFAULT, CREW_LIMIT_PER_JOB, crewRank, KEY_CREW_JOBS } from "@/lib/cast/crew-jobs";
import { tmdbCast, tmdbCrew } from "@/lib/db/schema";
import { tmdbImageUrl, type TmdbCastMember, type TmdbCrewMember } from "@/lib/tmdb/client";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** How many of the billed cast are kept for a title. */
export const CAST_KEPT = 24;

/** The crew worth keeping: only the key jobs, a few people per job, each person once per job, most important job first. */
export function keyCrew(crew: TmdbCrewMember[]): TmdbCrewMember[] {
  const perJob = new Map<string, number>();
  const seen = new Set<string>();
  const kept = crew.filter((c) => {
    const job = c.job ?? "";
    if (!c.name || crewRank(job) >= KEY_CREW_JOBS.length || seen.has(`${c.id}:${job}`)) return false;
    const n = perJob.get(job) ?? 0;
    if (n >= (CREW_LIMIT_PER_JOB[job] ?? CREW_LIMIT_DEFAULT)) return false;
    perJob.set(job, n + 1);
    seen.add(`${c.id}:${job}`);
    return true;
  });
  return kept.sort((a, b) => crewRank(a.job!) - crewRank(b.job!));
}

/** Replaces the stored cast and crew of one movie or show with these. */
export async function replaceCredits(ex: Db, kind: "movie" | "tv", tmdbId: number, credits: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] } | undefined): Promise<void> {
  const cast = [...(credits?.cast ?? [])].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999)).slice(0, CAST_KEPT);
  const crew = keyCrew(credits?.crew ?? []);
  await ex.delete(tmdbCast).where(and(eq(tmdbCast.kind, kind), eq(tmdbCast.tmdbId, tmdbId)));
  await ex.delete(tmdbCrew).where(and(eq(tmdbCrew.kind, kind), eq(tmdbCrew.tmdbId, tmdbId)));
  const seen = new Set<number>();
  const castRows = cast
    .filter((c) => c.name && !seen.has(c.id) && (seen.add(c.id), true))
    .map((c, position) => ({ kind, tmdbId, personId: c.id, name: c.name, character: c.character?.trim() || null, photoUrl: tmdbImageUrl(c.profile_path, "w342"), position }));
  if (castRows.length > 0) await ex.insert(tmdbCast).values(castRows);
  if (crew.length > 0) await ex.insert(tmdbCrew).values(crew.map((c, position) => ({ kind, tmdbId, personId: c.id, name: c.name, job: c.job!, photoUrl: tmdbImageUrl(c.profile_path, "w342"), position })));
}

/** Removes the stored cast and crew of one movie or show. */
export async function clearCredits(ex: Db, kind: "movie" | "tv", tmdbId: number): Promise<void> {
  await ex.delete(tmdbCast).where(and(eq(tmdbCast.kind, kind), eq(tmdbCast.tmdbId, tmdbId)));
  await ex.delete(tmdbCrew).where(and(eq(tmdbCrew.kind, kind), eq(tmdbCrew.tmdbId, tmdbId)));
}
