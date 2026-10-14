/** What a movie's or show's page gets from Does the Dog Die: the lines for its guide and choices dialog, the community's reports, and whether a play should ask first. */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { GuideLine } from "@/lib/content-filter/playback";
import { dddConfigured } from "@/lib/ddd/client";
import { serverDddAccess } from "@/lib/ddd/lookup";
import { dddFor, type DddAccess, type DddResult } from "@/lib/ddd/service";
import { dddCues, dddGuideLines, dddReports, type DddReport } from "@/lib/ddd/transform";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface DddMovieData {
  access: DddAccess;
  lines: GuideLine[];
  reports: DddReport[];
  /** Limited access with nothing kept yet: the Play button asks first (a moment later, through /api/ddd) before showing its choices. */
  pending: boolean;
}

const NONE: DddMovieData = { access: "disabled", lines: [], reports: [], pending: false };

/** A movie's community data. Full access asks when the page opens (with the counts for the guide); limited only shows what is already kept. */
export async function loadDddForMovie(ex: Db, serverId: string, title: { imdbId: string | null; tmdbId: number | null }): Promise<DddMovieData> {
  if (!dddConfigured()) return NONE;
  const access = await serverDddAccess(ex, serverId);
  if (access === "disabled") return NONE;
  const r = await dddFor({ imdbId: title.imdbId, tmdbId: title.tmdbId, kind: "movie" }, access, "page", { needStats: access === "full", timeoutMs: 2500 });
  if (r.status === "ok") return { access, lines: dddGuideLines(dddCues(r.data, { kind: "movie" })), reports: dddReports(r.data.stats), pending: false };
  return { ...NONE, access, pending: access === "limited" && r.status === "later" };
}

export interface DddShowData {
  access: DddAccess;
  result: DddResult | null;
  /** Limited access with nothing kept yet. */
  pending: boolean;
}

/** A show's community data (one set covers every episode). */
export async function loadDddForShow(ex: Db, serverId: string, show: { imdbId: string | null; tmdbId: number | null }): Promise<DddShowData> {
  if (!dddConfigured()) return { access: "disabled", result: null, pending: false };
  const access = await serverDddAccess(ex, serverId);
  if (access === "disabled") return { access, result: null, pending: false };
  const result = await dddFor({ imdbId: show.imdbId, tmdbId: show.tmdbId, kind: "tv" }, access, "page", { timeoutMs: 2500 });
  return { access, result, pending: access === "limited" && result.status === "later" };
}

/** The guide lines for one episode from a show's data. */
export function episodeLines(show: DddShowData, season: number, episode: number): GuideLine[] {
  return show.result?.status === "ok" ? dddGuideLines(dddCues(show.result.data, { kind: "episode", season, episode })) : [];
}
