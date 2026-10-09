/** Subtitle tracks in the database: what a title or episode has, adding and removing them, and what to search OpenSubtitles for. */
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { episodes, seasons, subtitleTracks, titles } from "@/lib/db/schema";
import type { Cue } from "./cues";
import type { SubtitleSearch } from "./opensubtitles";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface SubtitleOwner {
  kind: "title" | "episode";
  id: string;
}

export interface TrackInfo {
  id: string;
  language: string;
  label: string;
  source: "opensubtitles" | "upload";
  hearingImpaired: boolean;
  cueCount: number;
}

export const MAX_TRACKS_PER_OWNER = 20;
const LANGUAGE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/** A language code in the form the app keeps ("en", "pt-BR"), or null when it isn't one. */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (!LANGUAGE.test(lower)) return null;
  const [lang, region] = lower.split("-");
  return region ? `${lang}-${region.toUpperCase()}` : lang;
}

/** "English", "Portuguese (Brazil)": the language's own name for a menu, or the code itself when the runtime doesn't know it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A label for a track from what the admin typed, else from the language (with "(SDH)" for hearing-impaired ones). */
export function trackLabel(raw: unknown, language: string, hearingImpaired: boolean): string {
  const typed = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return typed || `${languageName(language)}${hearingImpaired ? " (SDH)" : ""}`;
}

const ownerWhere = (o: SubtitleOwner) => (o.kind === "title" ? eq(subtitleTracks.titleId, o.id) : eq(subtitleTracks.episodeId, o.id));

export async function listTracks(ex: Db, owner: SubtitleOwner): Promise<TrackInfo[]> {
  return ex
    .select({ id: subtitleTracks.id, language: subtitleTracks.language, label: subtitleTracks.label, source: subtitleTracks.source, hearingImpaired: subtitleTracks.hearingImpaired, cueCount: subtitleTracks.cueCount })
    .from(subtitleTracks)
    .where(ownerWhere(owner))
    .orderBy(asc(subtitleTracks.language), asc(subtitleTracks.hearingImpaired), asc(subtitleTracks.createdAt));
}

/** A track's cues, with who it belongs to (so the caller can check access to that owner). Null when there is no such track. */
export async function getTrack(ex: Db, trackId: string) {
  const [row] = await ex.select().from(subtitleTracks).where(eq(subtitleTracks.id, trackId)).limit(1);
  if (!row) return null;
  const owner: SubtitleOwner = row.titleId ? { kind: "title", id: row.titleId } : { kind: "episode", id: row.episodeId as string };
  return { owner, id: row.id, language: row.language, label: row.label, cues: row.cues as Cue[] };
}

export type AddResult = { ok: true; id: string } | { ok: false; status: 400 | 409; error: string };

export async function addTrack(
  ex: Db,
  args: { owner: SubtitleOwner; language: string; label: string; source: "opensubtitles" | "upload"; externalId?: string | null; hearingImpaired?: boolean; cues: Cue[]; createdBy: string | null }
): Promise<AddResult> {
  if (args.cues.length === 0) return { ok: false, status: 400, error: "That subtitle has nothing in it." };
  const [{ n }] = await ex.select({ n: sql<number>`count(*)::int` }).from(subtitleTracks).where(ownerWhere(args.owner));
  if (n >= MAX_TRACKS_PER_OWNER) return { ok: false, status: 409, error: `This already has ${MAX_TRACKS_PER_OWNER} subtitle tracks, the most it can hold. Remove one first.` };
  if (args.externalId) {
    const [dupe] = await ex
      .select({ id: subtitleTracks.id })
      .from(subtitleTracks)
      .where(and(ownerWhere(args.owner), eq(subtitleTracks.source, args.source), eq(subtitleTracks.externalId, args.externalId)))
      .limit(1);
    if (dupe) return { ok: false, status: 409, error: "That subtitle is already added." };
  }
  const [row] = await ex
    .insert(subtitleTracks)
    .values({
      titleId: args.owner.kind === "title" ? args.owner.id : null,
      episodeId: args.owner.kind === "episode" ? args.owner.id : null,
      language: args.language,
      label: args.label,
      source: args.source,
      externalId: args.externalId ?? null,
      hearingImpaired: args.hearingImpaired ?? false,
      cues: args.cues,
      cueCount: args.cues.length,
      createdBy: args.createdBy,
    })
    .returning({ id: subtitleTracks.id });
  return { ok: true, id: row.id };
}

export async function deleteTrack(ex: Db, trackId: string): Promise<boolean> {
  const rows = await ex.delete(subtitleTracks).where(eq(subtitleTracks.id, trackId)).returning({ id: subtitleTracks.id });
  return rows.length > 0;
}

/** What to look for on OpenSubtitles for this movie or episode (languages are filled in by the caller); null when there is nothing to look up by. */
export async function searchTarget(ex: Db, owner: SubtitleOwner): Promise<Omit<SubtitleSearch, "languages"> | null> {
  if (owner.kind === "title") {
    const [t] = await ex.select({ tmdbId: titles.tmdbId, name: titles.name, year: titles.year }).from(titles).where(eq(titles.id, owner.id)).limit(1);
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
