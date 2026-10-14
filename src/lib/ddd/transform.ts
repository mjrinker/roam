/** Their reports into what Roam shows and acts on. */
import { isFilterCategory, type FilterCue } from "@/lib/content-filter/categories";
import type { GuideLine } from "@/lib/content-filter/playback";
import { categoryForTopic } from "@/lib/ddd/mapping";
import type { DddMoment, DddStat, DddTitleData } from "@/lib/ddd/types";

/** Their times are for one particular cut, so a scene is widened a little each side to cover a few seconds of difference. */
export const PAD_BEFORE_SECONDS = 2;
export const PAD_AFTER_SECONDS = 1;
/** A moment longer than this between "it starts" and "safe to carry on" is more likely a typo than a scene. */
const MAX_MOMENT_SECONDS = 900;
/** Topics only a handful of people reported are not worth listing. */
const MIN_REPORTS = 2;
const MAX_REPORTS = 24;

interface RawRating {
  yes?: number;
  voteSum?: number;
  isSceneAlert?: boolean;
  index1?: number | null;
  index2?: number | null;
  position1?: number | null;
  position2?: number | null;
  position3?: number | null;
  safePosition1?: number | null;
  safePosition2?: number | null;
  safePosition3?: number | null;
  topicId: number;
}

const seconds = (h: number | null | undefined, m: number | null | undefined, s: number | null | undefined): number | null =>
  [h, m, s].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? (h as number) * 3600 + (m as number) * 60 + (s as number) : null;

/**
 * The moments in a title's ratings that can be skipped: the community's own "yes" reports (not Scene Alerts, which are not part of the free
 * tier) that give both where it starts and where it is safe to carry on. `topicNames` names each topic.
 */
export function momentsFromRatings(ratings: RawRating[], topicNames: Map<number, string>): DddMoment[] {
  const out: DddMoment[] = [];
  for (const r of ratings) {
    if (r.isSceneAlert || !(r.yes && r.yes > 0) || (r.voteSum ?? 0) < 0) continue;
    const start = seconds(r.position1, r.position2, r.position3);
    const safe = seconds(r.safePosition1, r.safePosition2, r.safePosition3);
    if (start === null || safe === null || safe <= start || safe - start > MAX_MOMENT_SECONDS) continue;
    const name = topicNames.get(r.topicId);
    if (!name) continue;
    out.push({ topicId: r.topicId, topicName: name, season: r.index1 ?? -1, episode: r.index2 ?? -1, startSeconds: start, safeSeconds: safe });
  }
  return out;
}

export type DddOwner = { kind: "movie" } | { kind: "episode"; season: number; episode: number };

/** The scenes a viewer can choose to skip in a movie or in one episode: moments whose topic maps to a category, widened by a little. */
export function dddCues(data: DddTitleData, owner: DddOwner): FilterCue[] {
  const out: FilterCue[] = [];
  for (const m of data.moments) {
    // A movie's moments carry no season or episode; an episode takes only its own.
    if (owner.kind === "movie" ? data.kind !== "movie" || m.season >= 0 || m.episode >= 0 : data.kind !== "tv" || m.season !== owner.season || m.episode !== owner.episode) continue;
    const category = categoryForTopic(m.topicName);
    if (!category || !isFilterCategory(category)) continue;
    out.push({
      startSeconds: Math.max(0, m.startSeconds - PAD_BEFORE_SECONDS),
      endSeconds: m.safeSeconds + PAD_AFTER_SECONDS,
      category,
      // Their reports carry no strength: a reported scene counts at every threshold.
      severity: "high",
      channel: "both",
      note: m.topicName,
    });
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** The cues as guide lines, marked as from the community (they have no strength to show). */
export function dddGuideLines(cues: FilterCue[]): GuideLine[] {
  const byCategory = new Map<string, FilterCue[]>();
  for (const c of cues) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  return [...byCategory.entries()].map(([category, list]) => ({
    category: category as GuideLine["category"],
    severity: "high" as const,
    scenes: new Set(list.map((c) => `${Math.round(c.startSeconds)}-${Math.round(c.endSeconds)}`)).size,
    seconds: Math.round(list.reduce((sum, c) => sum + (c.endSeconds - c.startSeconds), 0)),
    source: "community" as const,
  }));
}

/** Both sources' lines in one list: a category in both keeps the file's strength and adds the scenes; one only in the community's is marked so. */
export function mergeGuideLines(fromFiles: GuideLine[], fromCommunity: GuideLine[]): GuideLine[] {
  const merged = new Map<string, GuideLine>(fromFiles.map((l) => [l.category, l]));
  for (const l of fromCommunity) {
    const mine = merged.get(l.category);
    merged.set(l.category, mine ? { ...mine, scenes: mine.scenes + l.scenes, seconds: mine.seconds + l.seconds } : l);
  }
  return [...merged.values()];
}

export interface DddReport {
  topicName: string;
  yes: number;
  no: number;
}

/** The topics more people said yes to than no: what the community reports about a title, most agreed first. */
export function dddReports(stats: DddStat[] | null): DddReport[] {
  return (stats ?? [])
    .filter((s) => s.yes >= MIN_REPORTS && s.yes > s.no)
    .sort((a, b) => b.yes - b.no - (a.yes - a.no) || a.topicName.localeCompare(b.topicName))
    .slice(0, MAX_REPORTS)
    .map((s) => ({ topicName: s.topicName, yes: s.yes, no: s.no }));
}
