/** What to search OpenSubtitles for, and the language codes the subtitle routes accept. Nothing about subtitles is stored. */
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, seasons, titles } from "@/lib/db/schema";
import type { SubtitleSearch } from "./opensubtitles";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface SubtitleOwner {
  kind: "title" | "episode";
  id: string;
}

const LANGUAGE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/** A language code in the form the app uses ("en", "pt-BR"), or null when it isn't one. */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (!LANGUAGE.test(lower)) return null;
  const [lang, region] = lower.split("-");
  return region ? `${lang}-${region.toUpperCase()}` : lang;
}

/** What to look for on OpenSubtitles for this movie or episode (languages are filled in by the caller); null when there is nothing to look up by. */
export async function searchTarget(ex: Db, owner: SubtitleOwner): Promise<Omit<SubtitleSearch, "languages"> | null> {
  if (owner.kind === "title") {
    const [t] = await ex.select({ tmdbId: titles.tmdbId, name: titles.name }).from(titles).where(eq(titles.id, owner.id)).limit(1);
    if (!t) return null;
    return t.tmdbId ? { type: "movie", tmdbId: t.tmdbId } : { type: "movie", query: t.name };
  }
  const [row] = await ex
    .select({ showTmdb: titles.tmdbId, showName: titles.name, season: seasons.number, episode: episodes.number })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .where(eq(episodes.id, owner.id))
    .limit(1);
  if (!row) return null;
  return row.showTmdb ? { type: "episode", parentTmdbId: row.showTmdb, season: row.season, episode: row.episode } : { type: "episode", query: row.showName, season: row.season, episode: row.episode };
}
