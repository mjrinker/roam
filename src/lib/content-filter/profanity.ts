/**
 * Muting spoken profanity from a film's subtitles: each subtitle line is checked against a word list, and the words found become
 * sound-only cues ("language"), timed within the line by where the word sits in the text. Subtitle lines are a few seconds long and the
 * spot of a word inside one is only estimated, so each mute is widened a little (more for a longer line). Only the times are kept, never
 * the subtitle's text.
 */
import type { FilterCue, FilterSeverity } from "@/lib/content-filter/categories";
import { cleanCueText, type Cue } from "@/lib/subtitles/cues";

/** Strongest first; a word matching several is as strong as the first that matches. Whole words only, so "hello" and "class" are safe. */
const WORDS: [FilterSeverity, RegExp][] = [
  ["high", /(\bmotherfuck\w*|\bfuck\w*|\bf\*{2,}\w*|\bshit\w*|\bs\*{2,}\w*|\b(?:cunt|cocksuck|whore|slut|nigg|fagg?|twat)\w*|\bretard(?:ed)?\b)/gi],
  ["medium", /\b(ass(hole|holes|es|wipe)?|dumbass|jackass|bastards?|bitch\w*|piss\w*|prick\w*|goddamn\w*|god ?damn\w*|dickhead\w*|tits?|boobs?|screw you)\b/gi],
  ["low", /\b(damn\w*|dammit|hell|crap\w*|bloody hell|jesus christ|christ almighty|oh my god)\b/gi],
];

export interface ProfanityMatch {
  severity: FilterSeverity;
  /** Where the word sits in the text (character offsets). */
  from: number;
  to: number;
}

/** Every listed word in some text, with its strength. A span claimed by a stronger word is not counted again by a weaker one. */
export function findProfanity(text: string): ProfanityMatch[] {
  const found: ProfanityMatch[] = [];
  for (const [severity, rule] of WORDS) {
    for (const m of text.matchAll(rule)) {
      const from = m.index ?? 0;
      const to = from + m[0].length;
      if (!found.some((f) => from < f.to && to > f.from)) found.push({ severity, from, to });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** A mute is widened by this much each side: more for a longer line, because a word's place in a long line is less certain. */
export const padSeconds = (lineSeconds: number) => Math.min(1, 0.3 + 0.08 * lineSeconds);
/** Mutes closer together than this are one. */
const MERGE_GAP_SECONDS = 0.3;
const MIN_MUTE_SECONDS = 0.5;
/** A "line" this long is not dialogue (a bad file); it is ignored rather than trusted. */
const MAX_LINE_SECONDS = 30;

/** Sound-only "language" cues for the words in a subtitle file's lines. `offsetSeconds` shifts the subtitle's clock onto the video's. */
export function languageCuesFromSubtitles(cues: readonly Cue[], offsetSeconds = 0): FilterCue[] {
  const out: FilterCue[] = [];
  for (const [start, end, raw] of cues) {
    const seconds = end - start;
    if (!(seconds > 0) || seconds > MAX_LINE_SECONDS) continue;
    const text = cleanCueText(raw);
    if (!text) continue;
    const pad = padSeconds(seconds);
    for (const m of findProfanity(text)) {
      const wordStart = start + (m.from / text.length) * seconds;
      const wordEnd = start + (m.to / text.length) * seconds;
      const from = Math.max(0, wordStart - pad + offsetSeconds);
      const to = Math.max(from + MIN_MUTE_SECONDS, wordEnd + pad + offsetSeconds);
      out.push({ startSeconds: Math.round(from * 100) / 100, endSeconds: Math.round(to * 100) / 100, category: "language", severity: m.severity, channel: "sound" });
    }
  }
  out.sort((a, b) => a.startSeconds - b.startSeconds);
  // Neighbouring mutes join, keeping the stronger word's strength.
  const merged: FilterCue[] = [];
  const rank = { low: 1, medium: 2, high: 3 };
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c.startSeconds <= last.endSeconds + MERGE_GAP_SECONDS) {
      last.endSeconds = Math.max(last.endSeconds, c.endSeconds);
      if (rank[c.severity] > rank[last.severity]) last.severity = c.severity;
    } else merged.push({ ...c });
  }
  return merged;
}
