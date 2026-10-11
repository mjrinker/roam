/** What TMDB says about a person that Roam doesn't store: a bio, and the work of theirs that is not on this server. Pure parts + one query. */
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, titles } from "@/lib/db/schema";
import { getPerson, tmdbImageUrl, type TmdbCombinedCredit, type TmdbPerson } from "@/lib/tmdb/client";
import { crewJobLabel, crewRank, KEY_CREW_JOBS } from "./crew-jobs";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface OffServerItem {
  key: string;
  title: string;
  year: number | null;
  posterUrl: string;
  roles: string[];
  /** Where to read about it (TMDB); it isn't on this server to open. */
  href: string;
}

export interface PersonInfo {
  bio: string | null;
  born: string | null;
  died: string | null;
  offServer: OffServerItem[];
}

/** Talk shows and news: appearing as oneself on these isn't a credit worth listing. */
const TALK_AND_NEWS_GENRES = [10767, 10763];
const SELF = /\b(self|himself|herself|themselves|themself)\b/i;
export const OFF_SERVER_LIMIT = 30;

const key = (type: string, id: number) => `${type === "tv" ? "tv" : "movie"}:${id}`;
const yearOf = (c: TmdbCombinedCredit): number | null => {
  const y = Number.parseInt((c.release_date || c.first_air_date || "").slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
};
const longDate = (iso: string | null | undefined): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
};

/** Every movie and show key ("movie:123", "tv:456") in a person's TMDB credits, for asking which are on the server. */
export function creditKeys(person: TmdbPerson): string[] {
  const all = [...(person.combined_credits?.cast ?? []), ...(person.combined_credits?.crew ?? [])];
  return [...new Set(all.filter((c) => c.media_type === "movie" || c.media_type === "tv").map((c) => key(c.media_type, c.id)))];
}

/** The bio, birth and death, and their best-known work that is NOT in `onServer`, from TMDB's answer. */
export function buildPersonInfo(person: TmdbPerson, onServer: ReadonlySet<string>): PersonInfo {
  const credits = new Map<string, { c: TmdbCombinedCredit; roles: string[]; popularity: number }>();
  const add = (c: TmdbCombinedCredit, role: string) => {
    if (c.media_type !== "movie" && c.media_type !== "tv") return;
    if (!c.poster_path || !(c.title || c.name)) return;
    const k = key(c.media_type, c.id);
    if (onServer.has(k)) return;
    const have = credits.get(k) ?? { c, roles: [], popularity: c.popularity ?? 0 };
    if (!have.roles.includes(role)) have.roles.push(role);
    credits.set(k, have);
  };
  for (const c of person.combined_credits?.cast ?? []) {
    if ((c.genre_ids ?? []).some((g) => TALK_AND_NEWS_GENRES.includes(g)) || (c.character && SELF.test(c.character))) continue;
    add(c, c.character?.trim() ? `as ${c.character.trim().split(" / ")[0]}` : "Actor");
  }
  for (const c of person.combined_credits?.crew ?? []) {
    if (c.job && crewRank(c.job) < KEY_CREW_JOBS.length) add(c, crewJobLabel(c.job));
  }
  const items = [...credits.entries()]
    .sort(([, a], [, b]) => b.popularity - a.popularity)
    .slice(0, OFF_SERVER_LIMIT)
    .map(([k, v]): OffServerItem => ({
      key: k,
      title: (v.c.title || v.c.name)!,
      year: yearOf(v.c),
      posterUrl: tmdbImageUrl(v.c.poster_path, "w342")!,
      roles: v.roles,
      href: `https://www.themoviedb.org/${v.c.media_type === "tv" ? "tv" : "movie"}/${v.c.id}`,
    }))
    .sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || a.title.localeCompare(b.title));
  const born = longDate(person.birthday);
  const place = person.place_of_birth?.trim();
  return {
    bio: person.biography?.trim() || null,
    born: born ? `Born ${born}${place ? ` in ${place}` : ""}` : place ? `Born in ${place}` : null,
    died: longDate(person.deathday) ? `Died ${longDate(person.deathday)}` : null,
    offServer: items,
  };
}

/** Which of these keys are movies or shows ANYWHERE on this server (visible to the viewer or not), so none of them is offered as missing. */
export async function serverHasKeys(ex: Db, serverId: string, keys: string[]): Promise<Set<string>> {
  const ids = [...new Set(keys.map((k) => Number(k.split(":")[1])))];
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await ex
      .select({ tmdbId: titles.tmdbId, kind: titles.kind })
      .from(titles)
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(and(eq(libraries.serverId, serverId), inArray(titles.tmdbId, ids.slice(i, i + 500)), inArray(titles.kind, ["movie", "show"])));
    for (const r of rows) if (r.tmdbId != null) found.add(`${r.kind === "show" ? "tv" : "movie"}:${r.tmdbId}`);
  }
  return found;
}

/**
 * Bio and off-server work for a person's page. Null when TMDB can't be reached (the page just goes without). `includeOffServer` is
 * false for a profile with an age limit: TMDB's credits carry no ratings, so what isn't on the server can't be checked against it.
 */
export async function loadPersonInfo(ex: Db, serverId: string, personId: number, opts: { includeOffServer: boolean }): Promise<PersonInfo | null> {
  try {
    const person = await getPerson(personId);
    const onServer = opts.includeOffServer ? await serverHasKeys(ex, serverId, creditKeys(person)) : new Set<string>();
    const info = buildPersonInfo(person, onServer);
    return opts.includeOffServer ? info : { ...info, offServer: [] };
  } catch {
    return null;
  }
}
