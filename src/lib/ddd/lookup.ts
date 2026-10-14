/** Which Does the Dog Die title a movie or episode is, and how much this server may use it. */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, seasons, servers, titles } from "@/lib/db/schema";
import type { DddAccess, DddLookup } from "@/lib/ddd/service";
import type { DddOwner } from "@/lib/ddd/transform";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** What a server's setting says; anything unexpected counts as disabled. */
export async function serverDddAccess(ex: Db, serverId: string): Promise<DddAccess> {
  const [row] = await ex.select({ a: servers.dddAccess }).from(servers).where(eq(servers.id, serverId)).limit(1);
  return row?.a === "full" || row?.a === "limited" ? row.a : "disabled";
}

/** The title to look up for a movie, or for an episode (its show, with the episode's own season and number). Null for anything else. */
export async function dddTarget(ex: Db, ownerKind: "title" | "episode" | "extra", ownerId: string): Promise<{ lookup: DddLookup; owner: DddOwner } | null> {
  if (ownerKind === "title") {
    const [t] = await ex.select({ imdbId: titles.imdbId, tmdbId: titles.tmdbId, kind: titles.kind }).from(titles).where(eq(titles.id, ownerId)).limit(1);
    return t && t.kind === "movie" ? { lookup: { imdbId: t.imdbId, tmdbId: t.tmdbId, kind: "movie" }, owner: { kind: "movie" } } : null;
  }
  if (ownerKind === "episode") {
    const [e] = await ex
      .select({ imdbId: titles.imdbId, tmdbId: titles.tmdbId, season: seasons.number, episode: episodes.number })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .where(eq(episodes.id, ownerId))
      .limit(1);
    return e ? { lookup: { imdbId: e.imdbId, tmdbId: e.tmdbId, kind: "tv" }, owner: { kind: "episode", season: e.season, episode: e.episode } } : null;
  }
  return null;
}
