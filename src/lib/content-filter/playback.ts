/** Cues on the playback clock, what one viewer's choices turn into (scenes to skip or silence), and the summary behind a parental guide. */
import { FILTER_CATEGORIES, severityAtLeast, type ContentFilterPrefs, type FilterCategory, type FilterCue, type FilterSeverity } from "@/lib/content-filter/categories";

export interface CueSegment {
  /** Where this segment starts on the playback clock. */
  startSeconds: number;
  durationSeconds: number;
  /** For a trimmed segment (one episode's slice of a combined file): the window of the physical file it plays. */
  inFileOffsetSeconds?: number;
  inFileEndSeconds?: number;
  /** This file's own cues, timed from the start of the physical file. */
  cues: FilterCue[] | null;
}

/** Every segment's cues moved onto the one clock; a cue straddling a trim window is cut to it, and one outside it is dropped. Sorted by start. */
export function playbackCues(segments: CueSegment[], durationSeconds: number): FilterCue[] {
  const out: FilterCue[] = [];
  for (const seg of segments) {
    const offset = seg.inFileOffsetSeconds ?? 0;
    const end = seg.inFileEndSeconds ?? offset + seg.durationSeconds;
    for (const c of seg.cues ?? []) {
      const from = Math.max(c.startSeconds, offset);
      const to = Math.min(c.endSeconds, end);
      if (to - from < 0.05) continue;
      const start = seg.startSeconds + (from - offset);
      if (start >= durationSeconds) continue;
      out.push({ ...c, startSeconds: start, endSeconds: Math.min(seg.startSeconds + (to - offset), durationSeconds) });
    }
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/** One stretch the player acts on: jump over it, or keep playing with the sound off. */
export interface PlaybackSkip {
  startSeconds: number;
  endSeconds: number;
  action: "skip" | "mute";
  /** Why, for the note shown when it happens ("Violence"). */
  categories: FilterCategory[];
}

/** Cues closer together than this are one stretch (skipping one then landing in the next is a stutter). */
const MERGE_GAP_SECONDS = 0.75;

/**
 * What this viewer's choices turn the cues into. A cue counts when its category is chosen and it is at least as strong as the threshold.
 * A picture or both-channel cue is skipped; a sound-only cue is muted (and a mute inside a skip is covered by the skip). Overlapping or
 * touching stretches of the same action merge.
 */
export function skipsFor(cues: readonly FilterCue[], prefs: ContentFilterPrefs): PlaybackSkip[] {
  const chosen = cues.filter((c) => {
    const threshold = prefs[c.category];
    return threshold !== undefined && severityAtLeast(c.severity, threshold);
  });
  const merge = (action: PlaybackSkip["action"], list: FilterCue[]): PlaybackSkip[] => {
    const out: PlaybackSkip[] = [];
    for (const c of [...list].sort((a, b) => a.startSeconds - b.startSeconds)) {
      const last = out[out.length - 1];
      if (last && c.startSeconds <= last.endSeconds + MERGE_GAP_SECONDS) {
        last.endSeconds = Math.max(last.endSeconds, c.endSeconds);
        if (!last.categories.includes(c.category)) last.categories.push(c.category);
      } else out.push({ startSeconds: c.startSeconds, endSeconds: c.endSeconds, action, categories: [c.category] });
    }
    return out;
  };
  const skips = merge("skip", chosen.filter((c) => c.channel !== "sound"));
  const mutes = merge("mute", chosen.filter((c) => c.channel === "sound")).filter((m) => !skips.some((s) => s.startSeconds <= m.startSeconds && s.endSeconds >= m.endSeconds));
  return [...skips, ...mutes].sort((a, b) => a.startSeconds - b.startSeconds);
}

export interface GuideLine {
  category: FilterCategory;
  /** The strongest cue in the category. */
  severity: FilterSeverity;
  /** How many scenes, and how long they add up to. */
  scenes: number;
  seconds: number;
}

const ORDER: Record<FilterSeverity, number> = { low: 1, medium: 2, high: 3 };

/** A parental guide from cues: per category, the strongest level, how many scenes and their total length. Categories with no scene are left out. */
export function guideFromCues(cues: readonly FilterCue[]): GuideLine[] {
  const lines: GuideLine[] = [];
  for (const category of FILTER_CATEGORIES) {
    const mine = cues.filter((c) => c.category === category);
    if (mine.length === 0) continue;
    // Several cue lines over the same span are one scene.
    const spans = new Set(mine.map((c) => `${Math.round(c.startSeconds)}-${Math.round(c.endSeconds)}`));
    lines.push({
      category,
      severity: mine.reduce((m, c) => (ORDER[c.severity] > ORDER[m] ? c.severity : m), mine[0].severity),
      scenes: spans.size,
      seconds: Math.round(mine.reduce((sum, c) => sum + (c.endSeconds - c.startSeconds), 0)),
    });
  }
  return lines;
}
