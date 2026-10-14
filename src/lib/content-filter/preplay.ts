/** The "before you watch" choices: what can still be chosen on top of a profile's own skips, and what a choice turns into. */
import { FILTER_SEVERITIES, severityAtLeast, type ContentFilterPrefs, type FilterCategory, type FilterSeverity } from "@/lib/content-filter/categories";
import type { GuideLine } from "@/lib/content-filter/playback";

/** The categories a movie or episode has scenes in that this profile does not already skip entirely (a "skip everything" choice leaves nothing to add). */
export function choosableLines(lines: readonly GuideLine[], prefs: ContentFilterPrefs): GuideLine[] {
  return lines.filter((l) => prefs[l.category] !== "low");
}

/** The thresholds a viewer may pick for a category on top of the profile's: only ones that skip more than the profile already does. Strongest-only first. */
export function stricterThan(profile: FilterSeverity | undefined): FilterSeverity[] {
  return FILTER_SEVERITIES.filter((s) => profile === undefined || (s !== profile && !severityAtLeast(s, profile)));
}

/** What to send for this play: only the categories where the pick skips more than the profile does. Empty when nothing was added. */
export function extraFromPicks(picks: Partial<Record<FilterCategory, FilterSeverity>>, profile: ContentFilterPrefs): ContentFilterPrefs {
  const out: ContentFilterPrefs = {};
  for (const [category, severity] of Object.entries(picks) as [FilterCategory, FilterSeverity][]) {
    if (stricterThan(profile[category]).includes(severity)) out[category] = severity;
  }
  return out;
}

/** An address with the per-play choices added. */
export function withSkipParam(href: string, encoded: string): string {
  if (!encoded) return href;
  const [path, hash = ""] = href.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}skip=${encoded}${hash ? `#${hash}` : ""}`;
}
