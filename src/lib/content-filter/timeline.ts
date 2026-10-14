/**
 * The progress bar without the scenes a viewer chose to skip: times and lengths measured as if those scenes were not in the film
 * ("view time"), and back to the video's own clock ("real time"). Muted scenes stay: they are still watched.
 */
import { FILTER_CATEGORIES, isFilterCategory, isFilterSeverity, normalizePrefs, severityAtLeast, type ContentFilterPrefs } from "@/lib/content-filter/categories";
import type { PlaybackSkip } from "@/lib/content-filter/playback";

export interface RemovedRange {
  start: number;
  end: number;
}

/** The stretches that are jumped over, sorted and with overlaps merged. */
export function removedRanges(skips: readonly Pick<PlaybackSkip, "startSeconds" | "endSeconds" | "action">[] | null | undefined): RemovedRange[] {
  const out: RemovedRange[] = [];
  for (const s of [...(skips ?? [])].filter((x) => x.action === "skip").sort((a, b) => a.startSeconds - b.startSeconds)) {
    const last = out[out.length - 1];
    if (last && s.startSeconds <= last.end) last.end = Math.max(last.end, s.endSeconds);
    else out.push({ start: s.startSeconds, end: s.endSeconds });
  }
  return out;
}

/** Real time -> view time. A moment inside a skipped scene is where the scene begins. */
export function toViewTime(real: number, removed: readonly RemovedRange[]): number {
  let cut = 0;
  for (const r of removed) {
    if (real >= r.end) cut += r.end - r.start;
    else if (real > r.start) return r.start - cut;
    else break;
  }
  return real - cut;
}

/** View time -> real time. Landing where a skipped scene begins means the moment after it. */
export function toRealTime(view: number, removed: readonly RemovedRange[]): number {
  let real = view;
  for (const r of removed) {
    // r.start in view terms is its real start minus what was cut before it; real is built up as scenes are passed
    if (real >= r.start) real += r.end - r.start;
    else break;
  }
  return real;
}

/** How long the film is without the skipped scenes. */
export const viewDuration = (durationSeconds: number, removed: readonly RemovedRange[]): number =>
  Math.max(0, durationSeconds - removed.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, durationSeconds) - Math.min(r.start, durationSeconds)), 0));

/** Whether a real time falls inside a skipped scene. */
export const isRemoved = (real: number, removed: readonly RemovedRange[]) => removed.some((r) => real > r.start && real < r.end);

// ── Choices made just before playing ──────────────────────────────────────

/** Two sets of choices together: for each category, the weaker threshold wins (it skips more). */
export function mergePrefs(a: ContentFilterPrefs, b: ContentFilterPrefs): ContentFilterPrefs {
  const out: ContentFilterPrefs = {};
  for (const c of FILTER_CATEGORIES) {
    const x = a[c];
    const y = b[c];
    out[c] = x && y ? (severityAtLeast(x, y) ? y : x) : (x ?? y);
    if (out[c] === undefined) delete out[c];
  }
  return out;
}

/** "violence:high,language:low": choices for one play, carried in the address. */
export function encodeSkipParam(prefs: ContentFilterPrefs): string {
  return FILTER_CATEGORIES.filter((c) => prefs[c] !== undefined).map((c) => `${c}:${prefs[c]}`).join(",");
}

/** The choices in an address, ignoring anything unknown or malformed. */
export function parseSkipParam(value: string | null | undefined): ContentFilterPrefs {
  const raw: Record<string, string> = {};
  for (const part of (value ?? "").slice(0, 400).split(",")) {
    const [category, severity] = part.split(":");
    if (isFilterCategory(category) && isFilterSeverity(severity)) raw[category] = severity;
  }
  return normalizePrefs(raw);
}

