/** The kinds of content a viewer can choose to skip, and how strong it is (the Movie Content Filter format's own words). */

export const FILTER_CATEGORIES = ["violence", "language", "sex", "nudity", "fear", "drugs", "discrimination", "commercial", "dispensable"] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number];

export const FILTER_SEVERITIES = ["low", "medium", "high"] as const;
export type FilterSeverity = (typeof FILTER_SEVERITIES)[number];

/** Which part of the film a cue is about: both picture and sound (skip it), or only the sound (silence it) or only the picture. */
export type FilterChannel = "both" | "picture" | "sound";

export const CATEGORY_LABELS: Record<FilterCategory, string> = {
  violence: "Violence",
  language: "Language",
  sex: "Sex",
  nudity: "Nudity",
  fear: "Fear and frightening scenes",
  drugs: "Drugs and alcohol",
  discrimination: "Discrimination",
  commercial: "Commercial content",
  dispensable: "Dispensable scenes",
};

export const SEVERITY_LABELS: Record<FilterSeverity, string> = { low: "Mild", medium: "Moderate", high: "Strong" };

/** One scene to skip or silence, timed on the video's own clock (or the playback's, once placed). */
export interface FilterCue {
  startSeconds: number;
  endSeconds: number;
  category: FilterCategory;
  severity: FilterSeverity;
  channel: FilterChannel;
  /** A short note from the file ("a dog dies"), when it has one. */
  note?: string;
}

/** A viewer's choice per category: skip it at this strength and above, or leave it alone (missing means leave it). */
export type ContentFilterPrefs = Partial<Record<FilterCategory, FilterSeverity>>;

export const isFilterCategory = (v: unknown): v is FilterCategory => typeof v === "string" && (FILTER_CATEGORIES as readonly string[]).includes(v);
export const isFilterSeverity = (v: unknown): v is FilterSeverity => typeof v === "string" && (FILTER_SEVERITIES as readonly string[]).includes(v);

const RANK: Record<FilterSeverity, number> = { low: 1, medium: 2, high: 3 };

/** Whether a viewer who skips `category` from `threshold` up would skip a cue of this strength. */
export const severityAtLeast = (severity: FilterSeverity, threshold: FilterSeverity) => RANK[severity] >= RANK[threshold];

/** Cleans a stored or submitted preference object: unknown categories and strengths are dropped. */
export function normalizePrefs(raw: unknown): ContentFilterPrefs {
  if (!raw || typeof raw !== "object") return {};
  const out: ContentFilterPrefs = {};
  for (const category of FILTER_CATEGORIES) {
    const v = (raw as Record<string, unknown>)[category];
    if (isFilterSeverity(v)) out[category] = v;
  }
  return out;
}
