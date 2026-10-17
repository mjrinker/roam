/** Which button, if any, to offer at this moment of playback. */
import type { SkipKind, SkipSegment } from "@/lib/skipdb/client";

export interface SkipButtonState {
  /** Which part this is for (credits for "Next episode" and "Skip credits"). */
  kind: SkipKind;
  /** What the button does: jump to the end of a segment, or go to the next episode. */
  action: "seek" | "next";
  label: string;
  /** For "seek": where to jump to. */
  toSeconds?: number;
  /** Whether SkipDB's data is behind it (so it carries their credit). */
  fromSkipdb: boolean;
}

const LABEL: Record<Exclude<SkipKind, "outro">, string> = { intro: "Skip intro", recap: "Skip recap", preview: "Skip preview" };
/** With no credits time known, "Next episode" appears for the last stretch of an episode. */
export const NEXT_FALLBACK_SECONDS = 25;
/** A button for a segment shows slightly before it starts and goes a moment before it ends. */
const LEAD_SECONDS = 0.5;
const TAIL_SECONDS = 1.5;

export function activeSkipButton(segments: readonly (SkipSegment & { source?: "own" | "detected" })[] | undefined, time: number, durationSeconds: number, hasNext: boolean): SkipButtonState | null {
  for (const s of segments ?? []) {
    if (time < s.startSeconds - LEAD_SECONDS || time >= s.endSeconds - TAIL_SECONDS) continue;
    if (s.kind === "outro") {
      // Credits: the next episode if there is one, else just past the credits.
      return hasNext ? { kind: "outro", action: "next", label: "Next episode", fromSkipdb: s.source === undefined } : { kind: "outro", action: "seek", label: "Skip credits", toSeconds: Math.min(s.endSeconds, Math.max(0, durationSeconds - 0.5)), fromSkipdb: s.source === undefined };
    }
    return { kind: s.kind, action: "seek", label: LABEL[s.kind], toSeconds: s.endSeconds, fromSkipdb: s.source === undefined };
  }
  // No credits segment known, but there is a next episode and the end is near.
  const hasOutro = (segments ?? []).some((s) => s.kind === "outro");
  if (hasNext && !hasOutro && durationSeconds > 120 && durationSeconds - time <= NEXT_FALLBACK_SECONDS && durationSeconds - time > 0.5) return { kind: "outro", action: "next", label: "Next episode", fromSkipdb: false };
  return null;
}

/** Which parts a profile skips without being asked. */
export type AutoSkipPrefs = Partial<Record<SkipKind, boolean>>;

/** A stable name for what a button would do, so that each part is auto-skipped once per play (going back into it is the viewer's choice). */
export const skipKey = (s: SkipButtonState) => `${s.kind}:${s.action === "seek" ? s.toSeconds : "next"}`;

/** The button to press for the viewer now, if this profile asked for that kind to be skipped and it hasn't been this play. */
export function autoSkipNow(state: SkipButtonState | null, prefs: AutoSkipPrefs | undefined, done: { has(key: string): boolean }): SkipButtonState | null {
  if (!state || !prefs || prefs[state.kind] !== true || done.has(skipKey(state))) return null;
  return state;
}

/** Cleans a stored or submitted choice: only the four kinds, only true. */
export function normalizeAutoSkip(raw: unknown): AutoSkipPrefs {
  const out: AutoSkipPrefs = {};
  if (raw && typeof raw === "object") for (const k of ["intro", "recap", "outro", "preview"] as const) if ((raw as Record<string, unknown>)[k] === true) out[k] = true;
  return out;
}
