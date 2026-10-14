/** Which button, if any, to offer at this moment of playback. */
import type { SkipKind, SkipSegment } from "@/lib/skipdb/client";

export interface SkipButtonState {
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

export function activeSkipButton(segments: readonly SkipSegment[] | undefined, time: number, durationSeconds: number, hasNext: boolean): SkipButtonState | null {
  for (const s of segments ?? []) {
    if (time < s.startSeconds - LEAD_SECONDS || time >= s.endSeconds - TAIL_SECONDS) continue;
    if (s.kind === "outro") {
      // Credits: the next episode if there is one, else just past the credits.
      return hasNext ? { action: "next", label: "Next episode", fromSkipdb: true } : { action: "seek", label: "Skip credits", toSeconds: Math.min(s.endSeconds, Math.max(0, durationSeconds - 0.5)), fromSkipdb: true };
    }
    return { action: "seek", label: LABEL[s.kind], toSeconds: s.endSeconds, fromSkipdb: true };
  }
  // No credits segment known, but there is a next episode and the end is near.
  const hasOutro = (segments ?? []).some((s) => s.kind === "outro");
  if (hasNext && !hasOutro && durationSeconds > 120 && durationSeconds - time <= NEXT_FALLBACK_SECONDS && durationSeconds - time > 0.5) return { action: "next", label: "Next episode", fromSkipdb: false };
  return null;
}
